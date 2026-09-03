import { useEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { yCollab } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';

import { languageFor } from './language';
import { themeExtensions } from './theme';

/**
 * CodeMirror 6 is not a React component. It owns a DOM node and changes it
 * through transactions, so this wrapper's whole job is to create one EditorView,
 * destroy it on unmount, and otherwise stay out of its way.
 *
 * It is **uncontrolled**, and since module 3.5 there is nothing to control it
 * with: the text lives in a Y.Text, `yCollab` keeps the editor and the document
 * in step in both directions, and React never sees the content at all. Remote
 * carets come from the same extension, drawn from awareness state.
 *
 * Switching tabs swaps EditorState rather than rebuilding the view, and one
 * state is cached per open document so the cursor and undo history survive.
 * Scroll position does **not** live in EditorState — it belongs to the view's
 * scrollDOM — so it is not preserved across tab switches (defect D9, deferred).
 * (The obvious alternative, one view per tab hidden with CSS, breaks
 * CodeMirror's measurement: a view laid out while hidden has no height.)
 */
/**
 * Where a search result wants the editor to go (module 12.3).
 *
 * `nonce` is what makes "the same match, chosen again" a new instruction: two
 * identical targets are otherwise indistinguishable, and the second click would
 * do nothing at all.
 */
export interface RevealRequest {
  docId: string;
  /** 1-based, as the palette reports it. */
  line: number;
  /** The matched text, re-found within the line rather than trusted as an
   *  offset: the match came from `File.content`, which lags the live Y.Doc by
   *  up to a flush, so a byte offset can be stale by the time it is used. */
  text: string;
  nonce: number;
}

export function CodeMirror({
  docId,
  path,
  ytext,
  awareness,
  readOnly,
  openDocIds,
  reveal,
}: {
  docId: string;
  path: string;
  ytext: Y.Text;
  awareness: Awareness;
  readOnly: boolean;
  /** Every currently open tab. Anything else in the state cache is stale. */
  openDocIds: string[];
  /** Null unless a search result asked for a position. */
  reveal?: RevealRequest | null;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const showing = useRef<string | null>(null);
  const revealed = useRef<string | null>(null);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const instance = new EditorView({ parent });
    view.current = instance;

    return () => {
      instance.destroy();
      view.current = null;
      states.current.clear();
      showing.current = null;
    };
  }, []);

  /** Forget the state of any tab that has been closed — its Y.Text belongs to a
   *  provider that has been destroyed. */
  const openKey = openDocIds.join('\0');
  useEffect(() => {
    const open = new Set(openKey.split('\0'));

    for (const key of [...states.current.keys()]) {
      if (!open.has(key)) states.current.delete(key);
    }
  }, [openKey]);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;

    const previous = showing.current;
    if (previous === docId) return;

    // Keep the outgoing tab exactly as the user left it, while it is still open.
    if (previous !== null && openDocIds.includes(previous)) {
      states.current.set(previous, instance.state);
    }

    let next = states.current.get(docId);
    if (!next) {
      next = EditorState.create({
        // yCollab applies *subsequent* Y updates; it does not populate an empty
        // editor from a Y.Text that already has content. The initial value has
        // to come from the text itself — which is safe precisely because the
        // editor is not mounted until the provider is `ready` (module 5.1), so
        // this is the document as loaded from IndexedDB or the server, not a
        // second copy of it.
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          history(),
          highlightActiveLine(),
          bracketMatching(),
          EditorView.lineWrapping,
          keymap.of([
            {
              key: 'Mod-s',
              // Nothing to save — every keystroke is already shared. This exists
              // only so a habitual Ctrl+S does not open the browser's save dialog.
              run: () => true,
            },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          ...languageFor(path),
          ...themeExtensions,
          // The binding itself: text both ways, plus remote cursors.
          yCollab(ytext, awareness),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ],
      });
    }

    instance.setState(next);
    showing.current = docId;
  }, [docId, path, ytext, awareness, readOnly, openDocIds]);

  /**
   * Move the cursor to a search hit.
   *
   * Declared AFTER the state-switch effect on purpose: both fire in the same
   * commit when a result opens a file that was not already open, and revealing
   * a position in the outgoing tab's state would scroll the wrong document.
   *
   * This dispatches a transaction; it never rebuilds the view or the state, so
   * undo history, the Yjs binding and every remote caret are untouched. A
   * selection IS shared through awareness — that is the same thing clicking in
   * the editor does, and it is what makes "jump here" visible to a collaborator.
   */
  useEffect(() => {
    const instance = view.current;
    if (!instance || !reveal || reveal.docId !== docId) return;

    // One reveal per request. Without this, switching away from the tab and
    // back would drag the cursor to an old search hit.
    //
    // The guard is CLAIMED inside the timeout below, never here. React 19's
    // StrictMode mounts twice: setting it here meant the first pass claimed the
    // key and had its work cancelled by the cleanup, while the second pass saw
    // the key already claimed and did nothing. The symptom was a reveal that
    // worked on an already-open tab and silently failed on a newly opened one —
    // found in the browser, not by reading this file.
    const key = `${reveal.docId}:${reveal.nonce}`;
    if (revealed.current === key) return;

    /**
     * Deferred to a macrotask, and not as defensive padding.
     *
     * When a result opens a file that was NOT already open, this effect runs in
     * the same commit as the editor's first mount — which under StrictMode is
     * the mount that gets thrown away. Deferring lets the surviving mount be the
     * one that dispatches.
     *
     * `setTimeout` rather than `requestAnimationFrame`: rAF does not fire in a
     * tab that is not being painted, and a reveal that only works while you are
     * watching is a reveal that fails under automation and in a background tab.
     * Measured — the rAF version never fired at all in the verification tab.
     */
    const timer = setTimeout(() => {
      revealed.current = key;

      const doc = instance.state.doc;
      // The document may have shrunk since the match was read from the server.
      const line = doc.line(Math.min(Math.max(1, reveal.line), doc.lines));

      const column =
        reveal.text.length > 0 ? line.text.toLowerCase().indexOf(reveal.text.toLowerCase()) : -1;

      const from = column >= 0 ? line.from + column : line.from;
      const to = column >= 0 ? from + reveal.text.length : line.to;

      instance.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      });
      instance.focus();
    }, 0);

    return () => clearTimeout(timer);
  }, [reveal, docId]);

  return <div ref={host} className="h-full overflow-hidden" />;
}
