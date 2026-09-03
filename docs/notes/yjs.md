# Yjs — what it does, and what we built around it

~15 lines of working knowledge from Phase 3, per `docs/PLAN.md`. Not a tutorial.

**CRDT / YATA.** Every character is an item with a unique id (`clientID`, clock),
and a left/right neighbour. Concurrent inserts at the same offset are ordered
deterministically by those ids, so every peer reaches the same string without a
server deciding — which is why our two-peer same-offset test converges rather
than picking a winner. Deletes leave **tombstones**: the item stays, marked
deleted, because a later peer may still reference it as a neighbour.

**Client ids and clocks.** A `Y.Doc` picks a random `clientID` at construction.
Rebuilding a document from plain text — which our interim flush forces on every
eviction — produces items with *new* ids for the same characters. Two docs built
that way cannot recognise each other's text as the same text, and merging them
duplicates it. That is the whole reason Phase 4 stores real Yjs updates rather
than strings, and why offline persistence (5.1) must not land before it.

**State vectors.** A state vector is "the highest clock I have seen per client" —
a few bytes per peer. Sync step 1 sends yours, step 2 replies with only what you
are missing. This is why joining a large document costs one round trip and not a
full copy of the history.

**Updates are commutative and idempotent.** Applying the same update twice is
harmless, and order does not matter. That is what lets our fan-out be a dumb
broadcast to everyone except the origin, with no sequencing or acknowledgement.

**What Yjs does not do.** Transport, authentication, authorization, persistence,
and presence semantics. Awareness is a separate protocol with its own message
type; it is ephemeral, times out on its own, and the server relays it without
reading it. Everything in `modules/collab/` is ours: the handshake, the room
registry, who may write, and when text reaches the database.
