import type { ButtonHTMLAttributes } from 'react';

import { SpinnerIcon } from './icons';

/**
 * The one button.
 *
 * Before module 10.1 the client had NINE distinct button class strings for what
 * is really four variants at three sizes — including one accent button in
 * RunPanel that used `text-black` while the other nine used `text-surface`.
 * That is the kind of drift a shared primitive prevents by construction rather
 * than by review.
 *
 * `loading` is a prop here rather than a separate Spinner component (decision
 * A3). It does NOT replace the label: callers already write the better copy
 * themselves — `{submitting ? 'Signing in…' : 'Sign in'}` — so this only adds
 * the indicator and the disabled state.
 */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

/**
 * The focus ring is the single most important thing in this file. The client
 * had ZERO focus-visible styles before 10.1: inputs stripped the native outline
 * and buttons had nothing, so keyboard users had no idea where they were.
 * focus-visible (not focus) keeps the ring off mouse clicks.
 */
const BASE =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded font-medium ' +
  'transition-colors duration-100 outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-surface ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-surface hover:bg-accent-hover',
  secondary: 'border border-line bg-transparent text-ink hover:border-line-strong hover:bg-elevated',
  ghost: 'text-muted hover:bg-elevated hover:text-ink',
  danger: 'bg-danger text-surface hover:brightness-110',
};

const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-xs',
  lg: 'h-10 px-4 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  fullWidth = false,
  disabled,
  className,
  children,
  // Defaulted because a bare <button> inside a <form> submits it. Every caller
  // that wants a submit says so; nothing submits by accident.
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      className={[
        BASE,
        VARIANT[variant],
        SIZE[size],
        fullWidth ? 'w-full' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {loading ? <SpinnerIcon className="h-3.5 w-3.5" /> : null}
      {children}
    </button>
  );
}
