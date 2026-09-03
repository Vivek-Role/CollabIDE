# ADR-001 — Yjs transport: a hand-rolled `y-protocols` WebSocket server

**Status:** Accepted · **Decided:** Phase 3 (2026-08-12) · **Implemented:** modules 3.1–3.5
**Code:** `apps/server/src/modules/collab/` · `packages/shared/src/protocol.ts`

---

## Context

Yjs supplies the CRDT. It does not supply a server. Something has to accept a WebSocket,
decide whether this user may open this document, keep one `Y.Doc` per open file, relay
`y-protocols` sync and awareness messages between the sockets in that room, and hand the
document to a persistence layer.

Three ready-made options existed, and one of them ships in the box.

## Decision

**Write the server, using `y-protocols` directly** — roughly 250 lines across
`wsServer.ts` (handshake), `room.ts` (registry) and `syncHandler.ts` (relay), with the wire
contract in `packages/shared/src/protocol.ts` so client and server compile against the same
definition.

The frame format is deliberately minimal: **binary only**, byte 0 is a message-type varint
(`0` Sync, `1` Awareness), and the rest is handed to `y-protocols` unmodified.

## Alternatives rejected

| Option | Why not |
|---|---|
| **`y-websocket`'s bundled server** | A black box at exactly the seams this project is about: no hook for authenticating the upgrade, no per-document authorization, no place to put our persistence, no cross-instance fan-out. Every one of those would have been a fork |
| **Hocuspocus** | A good product, and the right answer for a team shipping a feature. Its extension model hides the sync and awareness mechanics — which is what this project exists to understand |
| **Socket.IO or a JSON protocol** | Yjs updates are binary. Base64 in JSON inflates every keystroke and buys nothing |

## Consequences

**Gained:** control at every seam. Authorization runs inside the handshake; the room
registry is ours to reference-count; persistence attaches to the `Y.Doc` directly
(ADR-002); and the Redis fan-out of ADR-003 was a change to two call sites rather than a
fork.

**Paid:** we own the reconnect edge cases, the framing, and the close-code vocabulary.
Phase 5 is the bill for that, and `docs/plans/summary5.md` is its receipt.

**Rules that fell out, and must hold:**

- **The session cookie authenticates the upgrade.** See *Corrections*.
- **Every rejection is an application close code, not a pre-upgrade HTTP status.** The
  vocabulary lives in `protocol.ts:67-79`:

  | Code | Meaning |
  |---|---|
  | `4400` | malformed request |
  | `4401` | unauthenticated |
  | `4403` | forbidden — *reachable in code, unreachable in practice while VIEWER is the floor* |
  | `4404` | not a member, or no such file |
  | `4409` | access changed, or the file was deleted |

- **`originCheck` guards mutating HTTP methods, and an upgrade is a GET** — so
  `wsServer.ts` checks `Origin` itself (`wsServer.ts:79`).
- **Authorization runs once, at join, before the socket joins a room.** That is safe only
  because a role change, a removal, a project delete and a file delete all close the
  affected sockets with `4409` (module 3.4b). There is no per-message check and no timer;
  adding one would be the wrong fix to a problem that is already solved.
- **`conns.size` is the reference count.** A room is destroyed exactly when it reaches
  zero, and only from `leaveRoom` (`room.ts:164`).
- **`rooms` is a `Map<docId, Promise<Room>>` and the promise is inserted synchronously**
  (`room.ts:48`). Two sockets racing a cold document would otherwise seed it twice — which
  reads, to a user, as the file's text appearing twice.

## Corrections

**`docs/PLAN.md`'s module map (row 3.2) says "HTTP upgrade, JWT from query param". That
was never built, deliberately.**

The **session cookie** authenticates the upgrade (`wsServer.ts:93`). A token in a URL lands
in proxy logs, browser history and `Referer` headers; there is no reason to put one there
when the browser will send a cookie on the handshake anyway. No query-parameter
authentication path exists anywhere in the codebase.

This forced a second decision that is easy to mistake for a bug: **rejections cannot be
HTTP 401s.** A browser cannot read the status of a failed upgrade — `onclose` reports 1006
with no reason — so the server completes the handshake and then closes with a specific
application code. Phase 8's harness rediscovered this from the outside: a client with a bad
cookie still "opens" (`docs/plans/summary8.md`, correction C1).

## See also

- `docs/ARCHITECTURE.md` §§3, 7 — the edit path and the authorization model
- `docs/notes/yjs.md` — CRDT/YATA intuition, client ids, state vectors, tombstones
- ADR-003 — how this transport was extended across instances without forking it
