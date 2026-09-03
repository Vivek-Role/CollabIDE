import { parentPort, workerData } from 'node:worker_threads';

import { connectClient, hashText, type LoadClient } from './client.js';
import type { ClientResult, WorkerInput } from './config.js';
import { makeMarker, scanMarkers, type Sample } from './latency.js';

/**
 * One worker thread owns K clients: K sockets, K Y.Docs, K typing intervals.
 *
 * It decides nothing. Every assignment — which doc, which server, when to
 * connect — is computed in the main thread and arrives in workerData, so
 * round-robin lives in exactly one place and a run is reproducible.
 *
 * It reports twice: `ready` once its clients have connected, and `done` with
 * counts at the end. There is deliberately no per-edit message, which would
 * serialise the whole run through one MessagePort and measure that instead.
 */

const input = workerData as WorkerInput;

const sleepUntil = (at: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));

async function run(): Promise<ClientResult[]> {
  const clients: LoadClient[] = [];
  const failures = new Map<number, string>();
  const samples = new Map<number, Sample[]>();
  const probers = new Set<number>();

  // Connect on the schedule the main thread laid out across the ramp.
  await Promise.all(
    input.clients.map(async (plan) => {
      await sleepUntil(plan.connectAt);

      const client = connectClient({
        index: plan.index,
        server: plan.server,
        docId: plan.docId,
        cookie: plan.cookie,
      });
      clients.push(client);
      if (plan.isProber) probers.add(plan.index);

      /**
       * Latency observation. Every client watches inserted text; a marker that
       * is not its own is one sample of local-edit -> remote-apply.
       *
       * `seen` is per client: the same marker can be delivered more than once
       * across a resync, and the first arrival is the one that measures
       * propagation.
       */
      const mine: Sample[] = [];
      const seen = new Set<string>();
      samples.set(plan.index, mine);

      client.observeInserts((inserted) => {
        for (const marker of scanMarkers(inserted)) {
          if (marker.owner === plan.index || seen.has(marker.key)) continue;
          seen.add(marker.key);
          mine.push({ t: marker.ts, l: Date.now() - marker.ts });
        }
      });

      try {
        await client.opened;
      } catch (error) {
        // A rejected upgrade (4401, 4404, …) must be reported, never retried:
        // a load test that silently loses a quarter of its clients is worse
        // than one that fails.
        failures.set(plan.index, error instanceof Error ? error.message : String(error));
      }
    }),
  );

  parentPort?.postMessage({
    type: 'ready',
    connected: clients.filter((client) => client.closeCode() === 0).length,
  });

  // Nothing is typed during the ramp, so there is no ramp-period traffic for
  // module 8.2 to have to exclude later.
  await sleepUntil(input.typeStartAt);

  const period = Math.round(1000 / input.editsPerSec);
  const probePeriod = Math.round(1000 / input.probeHz);
  const timers: NodeJS.Timeout[] = [];

  for (const client of clients) {
    const isProber = probers.has(client.index);
    let seq = 0;
    let probeDue = false;

    if (isProber) {
      // A flag rather than a direct insert: the marker REPLACES that tick's
      // ordinary character instead of adding to the offered load, so probing
      // does not change how hard the server is being pushed.
      timers.push(
        setInterval(() => {
          probeDue = true;
        }, probePeriod),
      );
    }

    timers.push(
      setInterval(() => {
        if (client.closeCode() !== 0) return;

        if (probeDue) {
          probeDue = false;
          seq += 1;
          client.insertMarker(makeMarker(client.index, seq, Date.now()));
          return;
        }
        client.edit();
      }, period),
    );
  }

  await sleepUntil(input.typeEndAt);
  for (const timer of timers) clearInterval(timer);

  // Let in-flight updates land before anything is compared. Under two instances
  // this also covers the doc bus round trip.
  await new Promise((resolve) => setTimeout(resolve, input.settleMs));

  /**
   * Captured BEFORE anything is closed deliberately, so a non-zero code here is
   * always an unexpected close.
   *
   * This check is load-bearing rather than defensive: the server completes the
   * upgrade and THEN closes with an application code (wsServer.ts explains why
   * — a browser cannot read an HTTP 401 off a failed upgrade). So a client with
   * a bad cookie genuinely opens, and without this it would be counted as
   * connected and quietly contribute nothing.
   */
  const results = clients.map<ClientResult>((client) => {
    const code = client.closeCode();

    return {
      index: client.index,
      docId: client.docId,
      editsSent: client.editsSent(),
      markerChars: client.markerChars(),
      samples: samples.get(client.index) ?? [],
      textLength: client.text().length,
      textHash: hashText(client.text()),
      closeCode: code,
      error: failures.get(client.index) ?? (code === 0 ? undefined : `closed with ${code}`),
    };
  });

  // Shut down before reporting, so a leaked handle shows up as a thread that
  // will not exit rather than as a number nobody questions.
  for (const client of clients) client.close();
  await Promise.race([
    Promise.all(clients.map((client) => client.closed)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  for (const client of clients) client.destroy();

  return results;
}

run().then(
  (results) => {
    parentPort?.postMessage({ type: 'done', results });
  },
  (error: unknown) => {
    parentPort?.postMessage({
      type: 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  },
);
