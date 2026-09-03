import { Y_TEXT_KEY } from '@collab/shared';
import * as Y from 'yjs';

import { maybeCompact } from './compactor.js';
import type { DocStore } from './DocStore.js';
import { materializeContent } from './materialize.js';

/**
 * The write buffer: a document's updates, batched into the log.
 *
 * Every update applied to the Y.Doc — local or remote — is buffered and written
 * as one merged row per flush, so typing costs a write every couple of seconds
 * rather than one per keystroke (ADR-002).
 *
 * This file imports `yjs`; a DocStore implementation may not. The ban lives on
 * *storage*, which stays byte-opaque and therefore swappable. This is the
 * caller-side glue — it has to observe the document and merge updates — and it
 * still takes ids and a Y.Doc rather than a Room, so `persistence` imports
 * nothing from `collab` and the dependency runs one way.
 *
 * Reading the text for materialization couples this file to "a document is one
 * Y.Text named content", which has been true project-wide since Phase 3. The
 * alternative — a readText closure passed in from room.ts — is an indirection
 * for no benefit today.
 */

const FLUSH_DELAY_MS = 2_000;
const FLUSH_BYTES = 64 * 1024;

export interface DocPersistence {
  /** Writes everything buffered at the moment of the call. Safe when empty. */
  flush(): Promise<void>;
  /** Stops observing and cancels the timer. Does not write — callers flush first. */
  detach(): void;
}

export interface AttachOptions {
  docId: string;
  /** Needed for materialization: a docId is opaque and is never parsed. */
  fileId: string;
  ydoc: Y.Doc;
  store: DocStore;
}

export function attachPersistence({ docId, fileId, ydoc, store }: AttachOptions): DocPersistence {
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Flushes run one after another, so two of them cannot interleave and land
  // their rows out of order.
  let chain: Promise<void> = Promise.resolve();
  let detached = false;

  function clearTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  async function writeBatch(batch: Uint8Array[]): Promise<void> {
    if (batch.length === 0) return;

    const merged = Y.mergeUpdates(batch);

    try {
      await store.appendUpdate(docId, merged);
    } catch (error) {
      console.error(`[persistence] append failed for ${docId}`, error);

      // Put it back at the front rather than dropping edits: a transient
      // database failure should cost a delay, not a paragraph. The forced flush
      // at eviction is the last chance, and if that fails it is logged.
      buffered.unshift(merged);
      bufferedBytes += merged.byteLength;
      return;
    }

    // Derived text, written after the append that produced it and never before.
    // A failure here is logged and dropped, never rolled back and never
    // requeued: the log already holds the truth, and the next flush recomputes
    // the whole text anyway. Failing real edits to protect a projection of them
    // would be backwards.
    try {
      await materializeContent(fileId, ydoc.getText(Y_TEXT_KEY).toString());
    } catch (error) {
      console.error(`[persistence] materialize failed for ${docId}`, error);
    }

    // Also best-effort: a log that did not compact is merely longer, and the
    // next flush tries again. Takes no ydoc since module 11.2 — compaction
    // folds the log, not this instance's copy of the document.
    try {
      await maybeCompact(docId, store);
    } catch (error) {
      console.error(`[persistence] compaction failed for ${docId}`, error);
    }
  }

  function flush(): Promise<void> {
    // Captured synchronously, so "everything buffered when I called" is
    // literally what gets written; anything typed after this line belongs to the
    // next batch.
    const batch = buffered;
    buffered = [];
    bufferedBytes = 0;
    clearTimer();

    chain = chain.then(() => writeBatch(batch));
    return chain;
  }

  function onUpdate(update: Uint8Array): void {
    buffered.push(update);
    bufferedBytes += update.byteLength;

    if (bufferedBytes >= FLUSH_BYTES) {
      void flush();
      return;
    }

    // Deliberately not restarted per update: a debounce that resets on every
    // keystroke never fires while someone is actually typing. The first update
    // after a flush starts the clock, and the write happens FLUSH_DELAY_MS later.
    if (timer === null) {
      timer = setTimeout(() => {
        void flush();
      }, FLUSH_DELAY_MS);
    }
  }

  ydoc.on('update', onUpdate);

  return {
    flush,
    detach(): void {
      if (detached) return;
      detached = true;

      ydoc.off('update', onUpdate);
      // A live timer keeps the event loop open, which hangs the test run.
      clearTimer();
    },
  };
}
