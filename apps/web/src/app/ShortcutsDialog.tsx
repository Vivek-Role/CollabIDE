import { Dialog } from '../components';

/**
 * What the keyboard does, in one place.
 *
 * Written as data rather than markup so adding a shortcut is one line, and so
 * the list cannot drift into two columns that disagree about which key does
 * what. Every entry here is a shortcut that is actually registered — this is
 * documentation of behaviour, not a wish list.
 *
 * `mod` renders as ⌘ on a Mac and Ctrl everywhere else, matching what
 * ProjectPage actually listens for (`event.metaKey || event.ctrlKey`).
 */
const GROUPS: Array<{ title: string; items: Array<{ keys: string[]; label: string }> }> = [
  {
    title: 'Search',
    items: [
      { keys: ['mod', 'K'], label: 'Search files and their contents' },
      { keys: ['mod', 'P'], label: 'Go to file by name' },
      { keys: ['mod', '⇧', 'F'], label: 'Find text in this project' },
      { keys: ['↑', '↓'], label: 'Move through results' },
      { keys: ['↵'], label: 'Open the selected result' },
      { keys: ['Esc'], label: 'Clear the query, then close' },
    ],
  },
  {
    title: 'Files',
    items: [
      { keys: ['mod', 'B'], label: 'Show or hide the file tree' },
      { keys: ['Esc'], label: 'Clear the tree filter' },
      { keys: ['Middle click'], label: 'Close a tab' },
    ],
  },
  {
    title: 'Editing',
    items: [
      { keys: ['mod', 'S'], label: 'Does nothing — every keystroke is already shared' },
      { keys: ['mod', 'Z'], label: 'Undo your own edits' },
      { keys: ['Tab'], label: 'Indent' },
      { keys: ['?'], label: 'Open this list' },
    ],
  },
];

function Key({ label }: { label: string }) {
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

  return (
    <kbd className="rounded border border-line bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-ink">
      {label === 'mod' ? (isMac ? '⌘' : 'Ctrl') : label}
    </kbd>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" size="lg" onClose={onClose}>
      <div className="space-y-5">
        {GROUPS.map((group) => (
          <div key={group.title}>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
              {group.title}
            </h3>

            <ul className="space-y-1.5">
              {group.items.map((item) => (
                <li
                  key={`${group.title}-${item.label}`}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-xs text-ink">{item.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {item.keys.map((key) => (
                      <Key key={key} label={key} />
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
