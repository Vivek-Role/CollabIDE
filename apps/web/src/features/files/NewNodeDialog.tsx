import { useState } from 'react';
import type { FormEvent } from 'react';

import { Alert, Button, Dialog, Field } from '../../components';
import { toFileFormErrors } from './errors';
import type { FormErrors } from './errors';

/**
 * Asks for a path, not a name.
 *
 * The server creates missing parent directories in the same transaction, so
 * `a/b/c.py` in an empty project is one request and three rows. Making the user
 * create each level — or making the client do it for them — would be more
 * requests and more ways to end up half-finished.
 */
export function NewNodeDialog({
  initialPath,
  onCreate,
  onClose,
}: {
  initialPath: string;
  onCreate: (path: string, isDir: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [isDir, setIsDir] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({ message: '', fields: {} });
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (path.length === 0) {
      setErrors({ message: '', fields: { path: 'Path is required.' } });
      return;
    }

    setErrors({ message: '', fields: {} });
    setSubmitting(true);

    try {
      /**
       * Sent exactly as typed — no trim, no slash fixing, no normalizing.
       * The server rejects rather than sanitizes on purpose (paths.ts), and a
       * client that quietly repairs input leaves the two sides disagreeing
       * about what was actually created.
       */
      await onCreate(path, isDir);
      onClose();
    } catch (error) {
      setErrors(toFileFormErrors(error));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title={isDir ? 'New folder' : 'New file'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="new-node" variant="primary" loading={submitting}>
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="new-node" onSubmit={handleSubmit} noValidate>
        <div className="space-y-4">
          {errors.message ? <Alert>{errors.message}</Alert> : null}

          <Field
            id="node-path"
            type="text"
            label="Path from the project root"
            mono
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="src/main.py"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            disabled={submitting}
            error={errors.fields['path']}
            hint="Missing folders are created for you."
          />

          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={isDir}
              onChange={(event) => setIsDir(event.target.checked)}
              disabled={submitting}
              className="rounded border-line outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
            />
            Create a folder instead of a file
          </label>
        </div>
      </form>
    </Dialog>
  );
}
