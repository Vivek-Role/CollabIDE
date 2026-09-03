import { useEffect } from 'react';
import type { ReactNode } from 'react';

/**
 * One modal shell, used by create-project, invite-member, new-file, rename and
 * the two delete confirmations. Six hand-rolled modals would be six different
 * answers to "does Escape close this?".
 *
 * Deliberately small: no focus trap, no portal. It closes on Escape and on a
 * backdrop click, and it labels itself for assistive tech. Anything more belongs
 * in a real component library, which this project is not trying to write —
 * Phase 10 reaffirmed that and added only the three things below.
 *
 * Module 10.1 added: `size` (max-w-md was hardcoded, and MembersPanel needs
 * wider), a `footer` slot so callers stop hand-rolling the same
 * `flex justify-end gap-2` row six times, and a 120ms entry animation that
 * respects prefers-reduced-motion.
 */

type Size = 'sm' | 'md' | 'lg';

const SIZE: Record<Size, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
};

export function Dialog({
  title,
  size = 'md',
  onClose,
  footer,
  children,
}: {
  title: string;
  size?: Size;
  onClose: () => void;
  /** Rendered in a bordered row at the bottom. Omit to lay the actions out
   *  inside `children`, which is what the delete confirmations still do. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="dialog-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      // Only a click on the backdrop itself closes: a click that started inside
      // the panel and drifted out should not discard what the user typed.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`dialog-panel-in w-full ${SIZE[size]} rounded border border-line bg-panel shadow-panel`}
      >
        <h2 className="border-b border-line px-5 py-3 text-sm font-semibold text-ink">{title}</h2>

        <div className="p-5">{children}</div>

        {footer ? (
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
