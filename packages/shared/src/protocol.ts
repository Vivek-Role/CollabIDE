/**
 * The WebSocket contract, and the only place it is written down.
 *
 * Both sides of the collaboration protocol compile against this file — the
 * server in apps/server/src/modules/collab (modules 3.2–3.4) and the client
 * provider in apps/web/src/features/collab (module 3.5) — so a disagreement
 * between them is a build error rather than a socket that closes at runtime for
 * no visible reason.
 *
 * Deliberately dependency-free. Nothing here imports yjs: the message *payloads*
 * are opaque binary produced by y-protocols, and only the first byte — the type
 * tag below — is ours to interpret. That is also what lets apps/runner import
 * this package in Phase 6 without pulling in a CRDT it will never use.
 *
 * Frame layout, for reference (module 3.4 does the encoding):
 *
 *     ┌────────────┬──────────────────────────────┐
 *     │ type (var) │ y-protocols payload          │
 *     └────────────┴──────────────────────────────┘
 */

/** The WebSocket endpoint. Vite proxies it to :4000 in dev (module 3.2). */
export const WS_PATH = '/ws';

/** Query parameter carrying the doc id on the upgrade request. */
export const WS_DOC_PARAM = 'doc';

/**
 * The Y.Text inside every document. One text per file, always this key — the
 * server seeds it from File.content and the editor binds to it.
 */
export const Y_TEXT_KEY = 'content';

/** Separator in a doc id. Safe because a cuid contains no colon. */
export const DOC_ID_SEPARATOR = ':';

/** Longest either half of a doc id may be. A cuid is ~25 characters; this is
 *  deliberate slack rather than a tight fit. */
export const MAX_DOC_ID_PART_LENGTH = 64;

// ── message types ───────────────────────────────────────────────────────────

/**
 * Byte 0 of every binary frame.
 *
 * A `const` object with a matching type alias rather than a TS `enum`: an enum
 * is a runtime construct, which fights this repo's `verbatimModuleSyntax` +
 * `isolatedModules`. ROLE_RANK in module 1.3 set the same precedent.
 */
export const MessageType = {
  Sync: 0,
  Awareness: 1,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

// ── close codes ─────────────────────────────────────────────────────────────

/**
 * 4000–4999 is the application-private range of WebSocket close codes.
 *
 * These mirror the REST error codes on purpose — including the rule that a
 * non-member and a non-existent project are indistinguishable (NotFound, never
 * Forbidden), so project existence stays private.
 */
export const CloseCode = {
  /** Missing or malformed ?doc, a text frame, or an unknown message type. */
  BadRequest: 4400,
  /** No cookie, a bad or expired token, or a user that no longer exists. */
  Unauthenticated: 4401,
  /**
   * A member, but not senior enough. Reserved: joining a room needs only
   * VIEWER, and a VIEWER is admitted read-only rather than refused (module
   * 3.4), so nothing sends this in Phase 3.
   */
  Forbidden: 4403,
  /** Not a project of yours, or no such file in it. */
  NotFound: 4404,
  /** The file was deleted, or membership was revoked, while connected. */
  Gone: 4409,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

const CLOSE_REASONS: Record<CloseCode, string> = {
  [CloseCode.BadRequest]: 'Malformed request',
  [CloseCode.Unauthenticated]: 'Authentication required',
  [CloseCode.NotFound]: 'Document not found',
  [CloseCode.Forbidden]: 'Not permitted',
  [CloseCode.Gone]: 'Document is no longer available',
};

/** Short human text for a close code — for server logs and the client status
 *  line. Never says *why* in a way that distinguishes the 4401 cases. */
export function closeReason(code: CloseCode): string {
  return CLOSE_REASONS[code];
}

// ── doc ids ─────────────────────────────────────────────────────────────────

/** A document is one file: `${projectId}:${fileId}` (docs/PLAN.md:212, and the
 *  format DocUpdate.docId already documents in schema.prisma). */
export interface DocRef {
  projectId: string;
  fileId: string;
}

/** cuid/uuid-safe. Anything outside it is refused rather than cleaned up. */
const ID_PART_PATTERN = /^[A-Za-z0-9_-]+$/;

const MAX_DOC_ID_LENGTH = MAX_DOC_ID_PART_LENGTH * 2 + DOC_ID_SEPARATOR.length;

/** Both arguments come from the database, so this does not validate them. */
export function makeDocId(projectId: string, fileId: string): string {
  return `${projectId}${DOC_ID_SEPARATOR}${fileId}`;
}

function isIdPart(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.length <= MAX_DOC_ID_PART_LENGTH &&
    ID_PART_PATTERN.test(value)
  );
}

/**
 * Returns null — never throws — for anything that is not a valid doc id.
 *
 * The only caller is module 3.2's upgrade handler, whose job is to choose a
 * close code and destroy the socket; a value makes that a two-line branch,
 * where an exception would make it a try/catch. AppError is not used here on
 * purpose: it lives in apps/server, and this package may not import from an app.
 *
 * Invalid input is **rejected, never rewritten** — the same rule as
 * modules/files/paths.ts. A parser that quietly repaired its input would let two
 * peers disagree about which room they are in.
 */
export function parseDocId(docId: string): DocRef | null {
  if (typeof docId !== 'string') return null;
  if (docId.length === 0 || docId.length > MAX_DOC_ID_LENGTH) return null;

  const parts = docId.split(DOC_ID_SEPARATOR);
  if (parts.length !== 2) return null;

  const [projectId, fileId] = parts;
  if (!isIdPart(projectId) || !isIdPart(fileId)) return null;

  return { projectId, fileId };
}

// ── awareness ───────────────────────────────────────────────────────────────

/**
 * What each client publishes about itself, for remote cursors.
 *
 * The server relays awareness untouched and never reads this shape — it is here
 * so the two clients agree, and so module 3.5's presence helper has one type to
 * satisfy.
 */
export interface AwarenessUser {
  name: string;
  color: string;
}
