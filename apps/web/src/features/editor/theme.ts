import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * The editor's look.
 *
 * The chrome — background, text, gutter, selection — is written in terms of the
 * same --color-* custom properties as the rest of the app (index.css), so the
 * editor cannot drift away from the UI around it. CodeMirror injects ordinary
 * CSS, so a var() reference works exactly as it would in a stylesheet.
 *
 * The syntax colours below are the one exception: there is no --color-keyword in
 * a UI palette, and inventing six more app-wide tokens for something only this
 * file uses would be worse. They are the only literal colours in the client.
 */
const SYNTAX = {
  keyword: '#ff7b72',
  string: '#a5d6ff',
  number: '#79c0ff',
  comment: '#8b949e',
  functionName: '#d2a8ff',
  typeName: '#ffa657',
};

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'var(--color-surface)',
      color: 'var(--color-ink)',
      fontSize: '13px',
    },
    '.cm-content': {
      fontFamily: 'var(--font-mono)',
      caretColor: 'var(--color-accent)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--color-surface)',
      color: 'var(--color-muted)',
      border: 'none',
      borderRight: '1px solid var(--color-line)',
    },
    '.cm-activeLine': { backgroundColor: 'var(--color-elevated)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--color-elevated)',
      color: 'var(--color-ink)',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
    // CodeMirror renders the selection itself once the editor has focus, and
    // uses the native ::selection when it does not — both need colouring.
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--color-elevated)',
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'transparent',
      color: 'var(--color-accent)',
      fontWeight: '600',
    },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  },
  { dark: true },
);

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword], color: SYNTAX.keyword },
  { tag: [tags.string, tags.special(tags.string)], color: SYNTAX.string },
  { tag: [tags.number, tags.bool, tags.null], color: SYNTAX.number },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: SYNTAX.comment, fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: SYNTAX.functionName },
  { tag: [tags.typeName, tags.className, tags.definition(tags.typeName)], color: SYNTAX.typeName },
  { tag: tags.operator, color: 'var(--color-muted)' },
]);

export const themeExtensions = [editorTheme, syntaxHighlighting(highlightStyle)];
