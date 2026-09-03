import { randomUUID } from 'node:crypto';

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Redis } from 'ioredis';

import { config } from '../../config.js';

/**
 * The document bus: one Redis channel per open document, so two server
 * instances holding the same file see each other's updates and cursors.
 *
 * This module knows about **doc ids, bytes and channels**. It knows nothing
 * about Room, Y.Doc, Awareness or WebSockets — it takes an id and bytes, and
 * hands bytes back through a callback. Same discipline as modules/persistence:
 * the seam stays swappable and this file stays testable on its own.
 *
 * Delivery is at-most-once and that is the design, not a compromise (ADR-003):
 * durability lives in Postgres, and Yjs repairs any gap on the next sync
 * round-trip. A dropped frame costs nothing a state vector will not fix.
 */

/**
 * This process, for the lifetime of this process.
 *
 * Redis delivers a published message to *every* subscriber of the channel,
 * including our own subscriber connection. Without this tag every local edit
 * would come straight back to us. Generated at import: randomUUID does no I/O,
 * so this module still connects to nothing when it is merely imported.
 */
export const INSTANCE_ID = randomUUID();

/**
 * Byte 1 of the envelope. Deliberately NOT MessageType from @collab/shared:
 * that is the client-facing WebSocket contract, which Phase 7 does not touch,
 * and what travels here is a bare y-protocols payload rather than a framed
 * WebSocket message. Two contracts that happen to look alike are still two
 * contracts.
 */
export const DocFrameKind = {
  Sync: 0,
  Awareness: 1,
} as const;
export type DocFrameKind = (typeof DocFrameKind)[keyof typeof DocFrameKind];

export interface DocFrame {
  kind: DocFrameKind;
  /** For Sync, a Yjs update. For Awareness, an encodeAwarenessUpdate payload.
   *  In both cases exactly the bytes the receiver feeds back to y-protocols. */
  payload: Uint8Array;
}

interface EnvelopedFrame extends DocFrame {
  instanceId: string;
}

/** Channel per doc. A single global channel would deliver every keystroke in
 *  the system to every instance regardless of what it has open. */
export function docChannel(docId: string): string {
  return `doc:${docId}`;
}

/**
 *     ┌──────────────────┬────────────┬─────────────────────────┐
 *     │ instanceId (str) │ kind (var) │ payload (varUint8Array) │
 *     └──────────────────┴────────────┴─────────────────────────┘
 */
export function encodeFrame(instanceId: string, frame: DocFrame): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, instanceId);
  encoding.writeVarUint(encoder, frame.kind);
  encoding.writeVarUint8Array(encoder, frame.payload);
  return encoding.toUint8Array(encoder);
}

/** Null for anything that does not decode, or a kind we do not know. A bad
 *  frame on the bus must never take a server down. */
export function decodeFrame(bytes: Uint8Array): EnvelopedFrame | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    const instanceId = decoding.readVarString(decoder);
    const kind = decoding.readVarUint(decoder);

    if (kind !== DocFrameKind.Sync && kind !== DocFrameKind.Awareness) return null;

    return { instanceId, kind, payload: decoding.readVarUint8Array(decoder) };
  } catch {
    return null;
  }
}

// ── connections ─────────────────────────────────────────────────────────────
//
// Two, and both lazy.
//
// Two because a connection in subscribe mode cannot issue PUBLISH. Lazy because
// buildApp() must keep booting without Redis: importing this module opens
// nothing, exactly as modules/execution/queue.ts does for BullMQ.
//
// Neither may ever be the BullMQ queue connection (BullMQ owns and blocks on
// it) nor a run subscriber from modules/execution/registry.ts (subscribe mode,
// and torn down per run). Adding connections is fine; sharing roles is not.

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

/** Channel -> the room handler waiting on it. Also the record of what this
 *  process is subscribed to. */
const handlers = new Map<string, (frame: DocFrame) => void>();

/** ioredis reconnects on its own. That is the ONLY reconnect logic in this
 *  module — Phase 5's socket backoff has no counterpart here and must not grow
 *  one. */
function logError(role: string): (error: Error) => void {
  return (error) => console.error(`[docBus] ${role} connection error: ${error.message}`);
}

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(config.redisUrl);
    publisher.on('error', logError('publisher'));
  }
  return publisher;
}

function getSubscriber(): Redis {
  if (!subscriber) {
    const conn = new Redis(config.redisUrl);
    conn.on('error', logError('subscriber'));

    // messageBuffer, not message: the payload is binary and the string event
    // would mangle it.
    conn.on('messageBuffer', (channel: Buffer, message: Buffer) => {
      const frame = decodeFrame(new Uint8Array(message));

      // Our own echo, dropped before the payload is looked at, before the
      // handler is found, before anything touches a document.
      if (!frame || frame.instanceId === INSTANCE_ID) return;

      handlers.get(channel.toString())?.({ kind: frame.kind, payload: frame.payload });
    });

    subscriber = conn;
  }
  return subscriber;
}

// ── the interface ───────────────────────────────────────────────────────────

/** Idempotent: subscribing twice replaces the handler rather than delivering
 *  twice. */
export function subscribeDoc(docId: string, onFrame: (frame: DocFrame) => void): void {
  const channel = docChannel(docId);
  const known = handlers.has(channel);

  handlers.set(channel, onFrame);
  if (known) return;

  getSubscriber()
    .subscribe(channel)
    .catch((error: unknown) => {
      console.error(`[docBus] subscribe failed for ${channel}`, error);
    });
}

/**
 * Called from room eviction.
 *
 * **Returns before touching a connection if none exists.** That is load-bearing
 * rather than defensive: rooms.test.ts drives joinRoom/leaveRoom directly, never
 * subscribing, and its afterEach leaves every connection it handed out. A lazy
 * unsubscribe would open Redis in those tests just to leave a channel they never
 * joined.
 */
export function unsubscribeDoc(docId: string): void {
  if (!subscriber) return;

  const channel = docChannel(docId);
  if (!handlers.delete(channel)) return;

  subscriber.unsubscribe(channel).catch((error: unknown) => {
    console.error(`[docBus] unsubscribe failed for ${channel}`, error);
  });
}

/**
 * Fire-and-forget by design. This is called from inside a synchronous Yjs
 * observer, so awaiting a network hop there would put Redis latency in the
 * middle of every keystroke's fan-out. A failed publish is logged and dropped —
 * the next sync round-trip repairs it.
 */
export function publishDoc(docId: string, frame: DocFrame): void {
  const channel = docChannel(docId);

  getPublisher()
    .publish(channel, Buffer.from(encodeFrame(INSTANCE_ID, frame)))
    .catch((error: unknown) => {
      console.error(`[docBus] publish failed for ${channel}`, error);
    });
}

/**
 * Shutdown, and test teardown.
 *
 * A no-op when nothing ever connected — the property that lets it sit
 * unconditionally in src/index.ts beside closeQueue(). Idempotent, so a second
 * signal is harmless.
 */
export async function closeDocBus(): Promise<void> {
  handlers.clear();

  const open = [publisher, subscriber].filter((conn): conn is Redis => conn !== null);
  publisher = null;
  subscriber = null;

  await Promise.allSettled(open.map((conn) => conn.quit()));
}
