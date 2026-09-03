import { useState } from 'react';
import type { FormEvent } from 'react';

import { Alert, Button, Dialog, Field } from '../../components';
import { toProjectFormErrors } from './errors';
import type { FormErrors } from './errors';

export function CreateProjectDialog({
  onCreate,
  onClose,
}: {
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<FormErrors>({ message: '', fields: {} });
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (name.trim().length === 0) {
      setErrors({ message: '', fields: { name: 'Project name is required.' } });
      return;
    }

    setErrors({ message: '', fields: {} });
    setSubmitting(true);

    try {
      await onCreate(name.trim());
      onClose();
    } catch (error) {
      // The dialog stays open with the text as typed — closing it would make
      // the user retype something the server merely disagreed with.
      setErrors(toProjectFormErrors(error));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title="New project"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {/* The submit lives in the footer but the form is in the body, so it
              is wired by form id rather than by nesting. */}
          <Button type="submit" form="create-project" variant="primary" loading={submitting}>
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="create-project" onSubmit={handleSubmit} noValidate>
        <div className="space-y-4">
          {errors.message ? <Alert>{errors.message}</Alert> : null}

          <Field
            id="project-name"
            type="text"
            label="Name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
            error={errors.fields['name']}
          />
        </div>
      </form>
    </Dialog>
  );
}
