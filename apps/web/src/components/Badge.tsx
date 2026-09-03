import type { ReactNode } from 'react';

/**
 * A small status pill.
 *
 * Absorbs ProjectCard's ROLE_CLASS map, and carries the `dot` variant that
 * decision A3 folded in rather than shipping a separate StatusDot component —
 * a coloured dot and a pill are the same primitive at two sizes.
 *
 * Module 10.4 uses `dot` for the editor's connection status (Live /
 * Reconnecting… / Offline / Disconnected), which today is 10px grey text with
 * no colour semantics at all. 10.5 uses the pill for run results.
 */

type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger';

const TONE: Record<Tone, string> = {
  neutral: 'border-line text-muted',
  accent: 'border-accent/50 text-accent',
  success: 'border-success/50 text-success',
  warn: 'border-warn/50 text-warn',
  danger: 'border-danger/50 text-danger',
};

const DOT: Record<Tone, string> = {
  neutral: 'bg-muted',
  accent: 'bg-accent',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
};

export function Badge({
  tone = 'neutral',
  dot = false,
  className,
  children,
}: {
  tone?: Tone;
  /** Renders a leading status dot. With no children, the dot IS the badge. */
  dot?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  // A dot with no label is decorative — the surrounding text carries the
  // meaning, so it must not be announced as an empty element.
  if (dot && children === undefined) {
    return (
      <span
        aria-hidden="true"
        className={['inline-block h-2 w-2 shrink-0 rounded-full', DOT[tone], className ?? '']
          .filter(Boolean)
          .join(' ')}
      />
    );
  }

  return (
    <span
      className={[
        'inline-flex shrink-0 items-center gap-1.5 rounded border px-1.5 py-0.5',
        'text-[11px] leading-none tracking-wide',
        TONE[tone],
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {dot ? (
        <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${DOT[tone]}`} />
      ) : null}
      {children}
    </span>
  );
}
