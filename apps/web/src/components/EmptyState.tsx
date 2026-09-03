import type { ReactNode } from 'react';

/**
 * "There is nothing here, and here is why."
 *
 * Five places need this, and today four of them are a centred line of 12px grey
 * text: no projects, no files in the tree, no file selected in the editor, no
 * members yet, and the run panel before its first run. Only ProjectsPage has a
 * designed one, and its dashed-border treatment is what this generalises.
 *
 * `size: 'sm'` is for the ones that live inside a panel — the sidebar and the
 * run panel — where the full padding would push the content out of view.
 */

export function EmptyState({
  icon,
  title,
  hint,
  action,
  size = 'md',
  bordered = true,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  size?: 'sm' | 'md';
  /** The dashed frame. Off inside a panel that already has its own border. */
  bordered?: boolean;
}) {
  return (
    <div
      className={[
        'flex flex-col items-center justify-center text-center',
        size === 'sm' ? 'gap-1.5 px-3 py-6' : 'gap-2 px-4 py-10',
        bordered ? 'rounded border border-dashed border-line' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {icon ? <span className="text-muted">{icon}</span> : null}

      <p className={size === 'sm' ? 'text-xs text-ink' : 'text-sm text-ink'}>{title}</p>

      {hint !== undefined ? (
        <p className="max-w-xs text-xs text-muted">{hint}</p>
      ) : null}

      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
