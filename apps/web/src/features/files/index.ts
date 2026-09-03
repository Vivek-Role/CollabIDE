/**
 * The files feature's public surface. Nothing outside this folder imports its
 * files directly — same barrel rule the server modules follow.
 */
export { FileTree } from './FileTree';
export { useFileTree, ancestorPaths, subtreeIds } from './useFileTree';
export { toFileFormErrors, toFileMessage } from './errors';
