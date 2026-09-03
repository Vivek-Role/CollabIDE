import { useEffect, useRef } from 'react';

import { CloseIcon, FileIcon } from '../../components';
import type { OpenTab } from './useOpenFiles';

/**
 * One row of open files; the × closes one.
 *
 * There is no unsaved marker any more: since module 3.5 every keystroke is
 * already shared, so there is no such thing as an unsaved tab.
 *
 * The row stays a <div> wrapping two sibling <button>s. That is not an accident
 * and module 10.4 kept it: making the whole tab one button with the close
 * button nested inside would be a button inside a button, which is invalid HTML
 * and behaves unpredictably.
 *
 * Module 12.3 added two habits people bring from every other editor — middle
 * click to close, and the active tab scrolling itself into view when it is
 * chosen from somewhere else (the palette, or a file opened from the tree).
 * Neither touches which tabs exist; both are handled here rather than in
 * `useOpenFiles`, because they are about the strip, not the model.
 */
export function Tabs({
  tabs,
  activeId,
  onSelect,
  onClose,
}: {
  tabs: OpenTab[];
  activeId: string | null;
  onSelect: (fileId: string) => void;
  onClose: (fileId: string) => void;
}) {
  const strip = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // A tab opened by the palette can be off-screen in a long strip, and the
    // browser only scrolls for focus — which stays wherever the user put it.
    const active = strip.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

  return (
    <div
      ref={strip}
      className="relative flex shrink-0 overflow-x-auto border-b border-line bg-panel"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;

        return (
          <div
            key={tab.id}
            data-active={isActive}
            title={tab.path}
            // Middle click closes, the way it does in a browser and in every
            // editor this one is trying to feel like. `auxclick` is the event
            // that actually fires for button 1; `mousedown` would also scroll.
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.id);
              }
            }}
            className={[
              'group relative flex shrink-0 items-center gap-1.5 border-r border-line pl-3 pr-1.5',
              'transition-colors duration-100',
              // A 2px accent bar along the top marks the active tab. Background
              // alone was doing that job before, and against bg-panel it read as
              // "slightly different" rather than "selected".
              isActive
                ? 'bg-surface text-ink after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-accent'
                : 'text-muted hover:bg-elevated hover:text-ink',
            ].join(' ')}
          >
            <button
              type="button"
              onClick={() => onSelect(tab.id)}
              className="flex items-center gap-1.5 rounded py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
            >
              <FileIcon className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-accent' : 'text-muted'}`} />
              {tab.name}
            </button>

            <button
              type="button"
              onClick={() => onClose(tab.id)}
              aria-label={`Close ${tab.name}`}
              title={`Close ${tab.name}`}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted outline-none transition-colors duration-100 hover:bg-elevated-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
            >
              <CloseIcon className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
