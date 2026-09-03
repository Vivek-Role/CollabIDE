/**
 * The editor feature's public surface. Nothing outside this folder imports its
 * files directly — same barrel rule the server modules follow.
 */
export { EditorPane } from './EditorPane';
export type { RevealRequest } from './CodeMirror';
export { useOpenFiles } from './useOpenFiles';
export type { OpenTab } from './useOpenFiles';
