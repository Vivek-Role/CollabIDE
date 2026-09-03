import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DocFrameKind,
  INSTANCE_ID,
  closeDocBus,
  decodeFrame,
  docChannel,
  encodeFrame,
  publishDoc,
  subscribeDoc,
  unsubscribeDoc,
  type DocFrame,
} from '../src/modules/redis/docBus.js';

/**
 * Module 7.1 — the doc bus on its own. No rooms, no sockets, no Yjs.
 *
 * Two blocks. The envelope block is pure and always runs. The integration block
 * needs a real Redis and SKIPS ITSELF when there is none, because the rest of
 * this suite deliberately runs with Redis down (see execution.test.ts) and that
 * property is worth more than these four cases.
 *
 * What no test here covers: the wiring between attachRoomObservers and this
 * module, which config.docBusEnabled switches off under NODE_ENV=test. That is
 * proved by running two real instances — verification step 5 of the module plan
 * — and is the accepted cost of decision G.
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1000,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
  });

  probe.on('error', () => {
    // Swallowed: an unreachable Redis is the answer, not a crash.
  });

  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const hasRedis = await redisAvailable();

if (!hasRedis) {
  console.warn('[test] Redis is not reachable — skipping the docBus integration block');
}

describe('docBus envelope', () => {
  it('round-trips an instance id, a kind and a payload', () => {
    const payload = new Uint8Array([0, 1, 2, 250, 255]);
    const decoded = decodeFrame(encodeFrame('instance-a', { kind: DocFrameKind.Sync, payload }));

    expect(decoded).not.toBeNull();
    expect(decoded?.instanceId).toBe('instance-a');
    expect(decoded?.kind).toBe(DocFrameKind.Sync);
    expect(decoded?.payload).toEqual(payload);
  });

  it('round-trips an awareness frame and an empty payload', () => {
    const decoded = decodeFrame(
      encodeFrame(INSTANCE_ID, { kind: DocFrameKind.Awareness, payload: new Uint8Array() }),
    );

    expect(decoded?.kind).toBe(DocFrameKind.Awareness);
    expect(decoded?.payload).toEqual(new Uint8Array());
  });

  it('identifies our own frame as an echo, and another instance’s as not', () => {
    const mine = decodeFrame(
      encodeFrame(INSTANCE_ID, { kind: DocFrameKind.Sync, payload: new Uint8Array([1]) }),
    );
    const theirs = decodeFrame(
      encodeFrame('someone-else', { kind: DocFrameKind.Sync, payload: new Uint8Array([1]) }),
    );

    expect(mine?.instanceId).toBe(INSTANCE_ID);
    expect(theirs?.instanceId).not.toBe(INSTANCE_ID);
  });

  it('returns null for garbage and for an unknown kind', () => {
    expect(decodeFrame(new Uint8Array([255, 255, 255, 255]))).toBeNull();

    const badKind = encodeFrame('instance-a', {
      kind: 9 as DocFrameKind,
      payload: new Uint8Array([1]),
    });
    expect(decodeFrame(badKind)).toBeNull();
  });

  it('names one channel per document', () => {
    expect(docChannel('project1:file1')).toBe('doc:project1:file1');
    expect(docChannel('project1:file2')).not.toBe(docChannel('project1:file1'));
  });
});

describe.skipIf(!hasRedis)('docBus over Redis', () => {
  /** A stand-in for the other server instance. */
  const other = new Redis(REDIS_URL);

  afterAll(async () => {
    other.disconnect();
    await closeDocBus();
  });

  /** Pub/sub is asynchronous with no completion signal, so waiting for a frame
   *  that must NOT arrive means waiting a beat and asserting nothing came. */
  function received(docId: string): { frames: DocFrame[]; done: Promise<void> } {
    const frames: DocFrame[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));

    subscribeDoc(docId, (frame) => {
      frames.push(frame);
      resolve();
    });

    return { frames, done };
  }

  const settle = (ms = 250): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('does not deliver our own publish back to us', async () => {
    const docId = `p1:${Date.now()}-own`;
    const { frames } = received(docId);
    await settle(100);

    publishDoc(docId, { kind: DocFrameKind.Sync, payload: new Uint8Array([1, 2, 3]) });
    await settle();

    expect(frames).toHaveLength(0);
    unsubscribeDoc(docId);
  });

  it('delivers a frame from another instance', async () => {
    const docId = `p1:${Date.now()}-remote`;
    const { frames, done } = received(docId);
    await settle(100);

    const payload = new Uint8Array([9, 8, 7]);
    await other.publish(
      docChannel(docId),
      Buffer.from(encodeFrame('another-instance', { kind: DocFrameKind.Awareness, payload })),
    );
    await done;

    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe(DocFrameKind.Awareness);
    expect(frames[0]?.payload).toEqual(payload);
    unsubscribeDoc(docId);
  });

  it('stops delivering after unsubscribeDoc', async () => {
    const docId = `p1:${Date.now()}-unsub`;
    const { frames } = received(docId);
    await settle(100);

    unsubscribeDoc(docId);
    await settle(100);

    await other.publish(
      docChannel(docId),
      Buffer.from(
        encodeFrame('another-instance', {
          kind: DocFrameKind.Sync,
          payload: new Uint8Array([1]),
        }),
      ),
    );
    await settle();

    expect(frames).toHaveLength(0);
  });

  it('keeps documents apart', async () => {
    const a = `p1:${Date.now()}-a`;
    const b = `p1:${Date.now()}-b`;
    const first = received(a);
    const second = received(b);
    await settle(100);

    await other.publish(
      docChannel(a),
      Buffer.from(
        encodeFrame('another-instance', {
          kind: DocFrameKind.Sync,
          payload: new Uint8Array([42]),
        }),
      ),
    );
    await first.done;
    await settle(100);

    expect(first.frames).toHaveLength(1);
    expect(second.frames).toHaveLength(0);

    unsubscribeDoc(a);
    unsubscribeDoc(b);
  });
});
