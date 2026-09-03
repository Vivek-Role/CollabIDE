import type { InputHTMLAttributes } from 'react';

/**
 * A labelled text input, with its error and hint.
 *
 * Replaces the six identical `const INPUT_CLASS` declarations that were spread
 * across LoginPage, RegisterPage, CreateProjectDialog, InviteDialog,
 * NewNodeDialog and RenameDialog. They were always used as label + input +
 * error together, which is why 10.1 folded the planned `Input` into this one
 * component rather than shipping two (decision A3).
 *
 * `id` is required, not optional: the label needs a real htmlFor, and generating
 * one would hide the fact that every existing call site already has one.
 */

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'> {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  /** Paths and code read better in the mono stack — NewNodeDialog does this. */
  mono?: boolean;
}

export function Field({ id, label, error, hint, mono = false, ...rest }: FieldProps) {
  // Error wins over hint. That is the existing behaviour in NewNodeDialog,
  // where the hint "Missing folders are created for you." is replaced by the
  // validation message rather than stacked under it.
  const describedBy = error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>

      <input
        id={id}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
        className={[
          'w-full rounded border bg-surface px-3 py-2 text-[13px] text-ink',
          'outline-none transition-colors duration-100 placeholder:text-muted',
          'focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2',
          'focus-visible:ring-offset-surface',
          'disabled:cursor-not-allowed disabled:opacity-60',
          mono ? 'font-mono text-xs' : '',
          error !== undefined ? 'border-danger' : 'border-line hover:border-line-strong',
        ]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      />

      {error !== undefined ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
