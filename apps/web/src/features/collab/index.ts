/**
 * The collab feature's public surface. Nothing outside this folder imports its
 * files directly — same barrel rule the rest of the client follows.
 */
export { CollabProvider } from './CollabProvider';
export type { CollabStatus } from './CollabProvider';
export { Facepile } from './Facepile';
export { useCollabDocs } from './useCollabDocs';
export { presenceFor } from './presence';
