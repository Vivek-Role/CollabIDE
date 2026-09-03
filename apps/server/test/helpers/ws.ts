import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { MessageType, Y_TEXT_KEY } from '@collab/shared';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { buildApp } from '../../src/app.js';
import { attachWsServer } from '../../src/modules/collab/index.js';
import { closeDocBus } from '../../src/modules/redis/index.js';

/**
 * A real listening server, because supertest cannot do WebSockets — it drives an
 * app object with no port, and an upgrade needs a socket.
 *
 * Port 0 asks the OS for a free port, so tests never collide with the dev server
 * or with each other.
 */

export interface WsTestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startWsServer(): Promise<WsTestServer> {
  const server: Server = createServer(buildApp());
  const closeWs = attachWsServer(server);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      closeWs();
      // config.docBusEnabled is false under NODE_ENV=test, so nothing here ever
      // opens the bus — but if a test turns it on, this is what stops a live
      // Redis connection outliving the suite and keeping Vitest alive.
      await closeDocBus();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A headless Yjs peer: the smallest client that speaks the module 3.4 protocol,
 * so tests can assert that two of them converge. Module 3.5 builds the browser
 * equivalent.
 */
export interface YClient {
  socket: WebSocket;
  doc: Y.Doc;
  awareness: Awareness;
  text: () => string;
  closed: Promise<number>;
  close: () => void;
}

const REMOTE = 'remote';

export function connectYjs(url: string, cookie: string): YClient {
  const socket = new WebSocket(url, { headers: { cookie } });
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);

  // Awareness gives itself an empty local state on construction. Clearing it
  // means getStates() holds only what tests actually publish — and only what
  // arrives from a peer.
  awareness.setLocalState(null);

  let closeCode = 0;
  const closed = new Promise<number>((resolve) => {
    socket.on('close', (code) => {
      closeCode = code;
      resolve(code);
    });
  });

  const send = (message: Uint8Array) => {
    if (socket.readyState === socket.OPEN) socket.send(message);
  };

  const sync = (write: (encoder: encoding.Encoder) => void) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);
    write(encoder);
    send(encoding.toUint8Array(encoder));
  };

  socket.on('open', () => {
    sync((encoder) => syncProtocol.writeSyncStep1(encoder, doc));
  });

  socket.on('message', (data: Buffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));

    switch (decoding.readVarUint(decoder)) {
      case MessageType.Sync: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MessageType.Sync);
        syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE);
        if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder));
        return;
      }
      case MessageType.Awareness:
        applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), REMOTE);
        return;
      default:
        return;
    }
  });

  socket.on('error', () => {
    // A refused upgrade surfaces here; `closed` is what tests await.
  });

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    sync((encoder) => syncProtocol.writeUpdate(encoder, update));
  });

  awareness.on('update', ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
    if (origin === REMOTE) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Awareness);
    encoding.writeVarUint8Array(
      encoder,
      encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]),
    );
    send(encoding.toUint8Array(encoder));
  });

  return {
    socket,
    doc,
    awareness,
    text: () => doc.getText(Y_TEXT_KEY).toString(),
    closed,
    close: () => {
      if (closeCode === 0) socket.close();
    },
  };
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

/** Polls until the condition holds, so tests never guess at a sleep duration. */
export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for a condition');
}

/** Nothing should have happened — used to assert that a dropped write stays
 *  dropped, where waiting for a condition would prove the opposite. */
export async function settle(ms = 300): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ConnectResult {
  /** 1000 when the handshake passed (3.2 closes accepted sockets on purpose). */
  code: number;
  opened: boolean;
}

/**
 * Opens a socket and resolves once it closes, reporting the close code and
 * whether the handshake itself succeeded.
 */
export function connect(
  url: string,
  options: { cookie?: string; origin?: string } = {},
): Promise<ConnectResult> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  if (options.origin !== undefined) headers['origin'] = options.origin;

  const socket = new WebSocket(url, { headers });
  let opened = false;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timed out waiting for the socket to close'));
    }, 5000);

    socket.on('open', () => {
      opened = true;
    });
    socket.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, opened });
    });
    socket.on('error', () => {
      // An upgrade the server refuses at the HTTP level surfaces here; 'close'
      // still follows, which is what resolves the promise.
    });
  });
}
