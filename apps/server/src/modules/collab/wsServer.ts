import type { IncomingMessage, Server } from 'node:http';

import { CloseCode, WS_DOC_PARAM, WS_PATH, closeReason, parseDocId } from '@collab/shared';
import type { DocRef } from '@collab/shared';
import type { Role } from '@prisma/client';
import { WebSocketServer, type WebSocket } from 'ws';

import { config } from '../../config.js';
import { SESSION_COOKIE, authenticateToken, type AuthedUser } from '../auth/index.js';
import { handleConnection } from './syncHandler.js';

/**
 * The WebSocket door.
 *
 * This module decides who gets a socket. It does not decide what they may do
 * with it — that is module 3.4, which checks project membership and attaches
 * the socket to a room. Today an accepted connection is logged and closed.
 *
 * Two things here are not like the REST side, because there is no Express in an
 * HTTP upgrade: the session cookie is parsed by hand (cookie-parser is
 * middleware), and the Origin is checked here rather than by originCheck, which
 * only guards mutating methods — an upgrade is a GET.
 *
 * Every failure closes with an application close code from @collab/shared rather
 * than answering the upgrade with an HTTP 401. A browser cannot read that status
 * (onclose reports 1006 with no reason), so the client could never tell an
 * expired session from a dead server. Completing a handshake we are about to
 * close costs a few hundred bytes and gives every rejection in the phase — this
 * module's and 3.4's — one shape.
 */

export interface CollabConnection {
  socket: WebSocket;
  user: AuthedUser;
  doc: DocRef;
  /** Set by module 3.4 once membership is checked; null until then. */
  role: Role | null;
  /** EDITOR or above. A VIEWER's document updates are dropped server-side. */
  canWrite: boolean;
  /** Awareness client ids this socket owns, so its cursor can be removed the
   *  moment it disconnects rather than when awareness times out. */
  awarenessIds: Set<number>;
}

/** One cookie out of a raw Cookie header. cookie-parser is Express middleware
 *  and does not apply here; the `cookie` package would be a dependency for a
 *  single lookup. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

/** Rejects with a close code, so the client learns why. `close` also destroys
 *  the underlying socket once the frame is flushed — nothing is left half-open. */
function reject(socket: WebSocket, code: CloseCode): void {
  socket.close(code, closeReason(code));
}

/**
 * Validates an accepted socket and returns the connection, or closes it.
 *
 * The doc id is checked for **shape only**. Whether that project and file exist,
 * and whether this user may open them, is module 3.4's question.
 */
async function handshake(
  socket: WebSocket,
  request: IncomingMessage,
): Promise<CollabConnection | null> {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== config.webOrigin) {
    reject(socket, CloseCode.BadRequest);
    return null;
  }

  // req.url is a path, never absolute — the base is only there to satisfy URL.
  const url = new URL(request.url ?? '', 'http://localhost');
  const doc = parseDocId(url.searchParams.get(WS_DOC_PARAM) ?? '');

  if (!doc) {
    reject(socket, CloseCode.BadRequest);
    return null;
  }

  const token = readCookie(request.headers.cookie, SESSION_COOKIE);
  const user = token === undefined ? null : await authenticateToken(token);

  if (!user) {
    reject(socket, CloseCode.Unauthenticated);
    return null;
  }

  return { socket, user, doc, role: null, canWrite: false, awarenessIds: new Set() };
}

/**
 * Attaches the collaboration endpoint to the HTTP server from src/index.ts.
 * Returns a close function for shutdown.
 */
export function attachWsServer(server: Server): () => void {
  // noServer is what makes rejection possible at all: with { server }, ws would
  // complete the upgrade before this module got a say in it.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', 'http://localhost');

    // Not ours — say nothing and drop it, so an unrelated upgrade consumer
    // could be added later without this one swallowing its requests.
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      /**
       * Collect messages from the instant the socket opens.
       *
       * A client sends sync step 1 as soon as `open` fires, which is while the
       * handshake below is still waiting on its database query — and `ws` drops
       * messages that arrive with no listener attached. A lost step 1 is a
       * document that silently never syncs.
       */
      const early: Uint8Array[] = [];
      const collect = (data: Buffer, isBinary: boolean): void => {
        if (isBinary) early.push(new Uint8Array(data));
        else ws.close(CloseCode.BadRequest, closeReason(CloseCode.BadRequest));
      };
      ws.on('message', collect);

      void handshake(ws, request).then((connection) => {
        // Handing over is synchronous — handleConnection attaches its own
        // listener before it awaits anything, so there is no gap.
        ws.off('message', collect);

        // Authorization, the room and the message loop all live in
        // syncHandler.ts — this file's job ends once the socket is known to
        // belong to a real user.
        if (connection) void handleConnection(connection, early);
      });
    });
  });

  return () => wss.close();
}
