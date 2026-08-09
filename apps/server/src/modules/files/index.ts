/**
 * The files module's public surface.
 *
 * Module 6.6 uses `listTree`/`readFile` to materialize a project into a run
 * payload; module 4.4 writes `File.content` directly rather than through
 * `writeFile`, which is REST scaffolding.
 */

export { assertValidPath } from './paths.js';
export { filesRouter } from './routes.js';
export { listTree, readFile, type FileRecord, type TreeNode } from './service.js';
