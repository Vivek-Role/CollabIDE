import { useState } from 'react';
import type { FormEvent } from 'react';

import { Alert, Button, Dialog, Field } from '../../components';
import type { Role } from '../../lib/types';
import { toProjectFormErrors } from './errors';
import type { FormErrors } from './errors';

/**
 * The role picker stays a NATIVE <select>.
 *
 * Module 10.2 deliberately did not add a Select primitive: only two selects
 * exist in the whole client (this one and MembersPanel's), and an
 * accessibility-correct custom select is exactly the "concrete need" bar that
 * phase-10-plan D1 sets for adding a component. A native select is keyboard-
 * and screen-reader-correct for free, and on mobile it gets the platform
 * picker. If a third one ever appears, revisit.
 *
 * It is styled to match Field's input rather than inheriting from it, because
 * Field renders an <input> and this is not one.
 */
const SELECT_CLASS =
  'w-full rounded border border-line bg-surface px-3 py-2 text-[13px] text-ink ' +
  'outline-none transition-colors duration-100 hover:border-line-strong ' +
  'focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-60';

export function InviteDialog({
  onInvite,
  onClose,
}: {
  onInvite: (email: string, role: Role) => Promise<void>;
  onClose: () => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('EDITOR');
  const [errors, setErrors] = useState<FormErrors>({ message: '', fields: {} });
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (email.trim().length === 0) {
      setErrors({ message: '', fields: { email: 'Email is required.' } });
      return;
    }

    setErrors({ message: '', fields: {} });
    setSubmitting(true);

    try {
      await onInvite(email.trim(), role);
      onClose();
    } catch (error) {
      setErrors(toProjectFormErrors(error));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title="Add member"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="invite-member" variant="primary" loading={submitting}>
            {submitting ? 'Adding…' : 'Add member'}
          </Button>
        </>
      }
    >
      <form id="invite-member" onSubmit={handleSubmit} noValidate>
        <div className="space-y-4">
          {errors.message ? <Alert>{errors.message}</Alert> : null}

          {/**
           * People are invited by email, never by user id — ids are opaque and
           * are never exposed for lookup. The server does not validate the
           * address format here (schemas.ts), so a typo comes back as
           * USER_NOT_FOUND rather than a format complaint. The message says
           * exactly that instead of pretending the address was malformed.
           */}
          <Field
            id="invite-email"
            type="email"
            label="Email"
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
            error={errors.fields['email']}
          />

          <div>
            <label htmlFor="invite-role" className="mb-1 block text-xs font-medium text-muted">
              Role
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
              disabled={submitting}
              className={SELECT_CLASS}
            >
              <option value="VIEWER">Viewer — read only</option>
              <option value="EDITOR">Editor — can change files</option>
              <option value="OWNER">Owner — full control</option>
            </select>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
