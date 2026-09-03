/**
 * The files module's public surface.
 *
 * Module 6.6 uses `listTree`/`readFile` to materialize a project into a run
 * payload. `File.content` is written only by modules/persistence (4.4) — the
 * REST write path was removed with it, since anything it wrote would be
 * overwritten by the next flush.
 */

export { assertValidPath } from './paths.js';
export { filesRouter } from './routes.js';
export {
  listFilesForRun,
  listTree,
  readFile,
  type FileRecord,
  type TreeNode,
} from './service.js';
