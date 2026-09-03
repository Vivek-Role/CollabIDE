import type { ReactNode } from 'react';

import { AlertIcon } from './icons';

/**
 * An inline message.
 *
 * The string this replaces —
 *   rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger
 * — was copy-pasted into TEN files. One of them will always be the one that
 * drifts, which is the argument for a primitive rather than a convention.
 *
 * role="alert" is kept from every call site: these appear in response to a
 * failed action, and a screen reader should announce them without being asked.
 */

type Tone = 'danger' | 'warn' | 'info';

const TONE: Record<Tone, string> = {
  danger: 'border-danger/40 bg-danger/10 text-danger',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  info: 'border-accent/40 bg-accent/10 text-accent',
};

export function Alert({
  tone = 'danger',
  icon = false,
  className,
  children,
}: {
  tone?: Tone;
  /** Off by default: most call sites are one short line where a glyph is noise. */
  icon?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      role="alert"
      className={[
        'flex items-start gap-2 rounded border px-3 py-2 text-xs',
        TONE[tone],
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {icon ? <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0" /> : null}
      <span className="min-w-0">{children}</span>
    </p>
  );
}
