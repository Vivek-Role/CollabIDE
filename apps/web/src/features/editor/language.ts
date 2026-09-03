import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import type { Extension } from '@codemirror/state';

/**
 * Which language support to load for a file, decided by its extension.
 *
 * A plain map from extension to a factory. Named HIGHLIGHTERS, not LANGUAGES,
 * to keep it distinct from @collab/shared's LANGUAGES registry: this one says
 * how to COLOUR a file, that one says how to RUN it, and they disagree on
 * purpose — .ts highlights here and has no runtime there.
 *
 * Anything unknown opens as plain text. An unrecognised extension is a normal
 * thing for a file to have, not an error.
 */
const HIGHLIGHTERS = new Map<string, () => Extension>([
  ['py', python],
  ['js', () => javascript()],
  ['jsx', () => javascript({ jsx: true })],
  ['mjs', () => javascript()],
  ['cjs', () => javascript()],
  ['ts', () => javascript({ typescript: true })],
  ['tsx', () => javascript({ jsx: true, typescript: true })],
]);

export function languageFor(path: string): Extension[] {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');

  // No dot, or a dotfile like ".gitignore" with nothing after it.
  if (dot <= 0) return [];

  const create = HIGHLIGHTERS.get(base.slice(dot + 1).toLowerCase());
  return create ? [create()] : [];
}
