/**
 * The search feature's public surface. Nothing outside this folder imports its
 * files directly — same barrel rule the server modules and every other client
 * feature follow.
 *
 * Note what is NOT exported: `useProjectSearch`. The palette is the only thing
 * that runs a content scan, and exporting the hook would invite a second call
 * site firing its own 300 requests.
 */
export { SearchPalette } from './SearchPalette';
export type { PaletteMode, RevealTarget } from './SearchPalette';
export { Highlight } from './Highlight';
export { filterTree, directoryPaths, matchPath, flattenTree } from './match';
export type { FlatNode, Range } from './match';
