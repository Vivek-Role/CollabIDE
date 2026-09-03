import { useState } from 'react';
import type { FormEvent } from 'react';

import { Alert, Button, Dialog, Field } from '../../components';
import type { TreeNode as FileTreeNode } from '../../lib/types';
import { toFileFormErrors } from './errors';
import type { FormErrors } from './errors';

/**
 * Edits the whole path, which makes this rename *and* move — one dialog,
 * because on the server they are one operation: PATCH with a new path.
 *
 * Editing only the last segment would mean the client stitching parent + name
 * back into a path. Path construction on the client is the thing this API's
 * design avoids, and it is where a traversal bug would be introduced.
 */
export function RenameDialog({
  node,
  onMove,
  onClose,
}: {
  node: FileTreeNode;
  onMove: (fileId: string, path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [path, setPath] = useState(node.path);
  const [errors, setErrors] = useState<FormErrors>({ message: '', fields: {} });
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (path.length === 0) {
      setErrors({ message: '', fields: { path: 'Path is required.' } });
      return;
    }

    if (path === node.path) {
      onClose();
      return;
    }

    setErrors({ message: '', fields: {} });
    setSubmitting(true);

    try {
      await onMove(node.id, path);
      onClose();
    } catch (error) {
      setErrors(toFileFormErrors(error));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title={node.isDir ? 'Rename or move folder' : 'Rename or move file'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="rename-node" variant="primary" loading={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="rename-node" onSubmit={handleSubmit} noValidate>
        <div className="space-y-4">
          {errors.message ? <Alert>{errors.message}</Alert> : null}

          <Field
            id="rename-path"
            type="text"
            label="New path"
            mono
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            disabled={submitting}
            error={errors.fields['path']}
            hint={node.isDir ? 'Everything inside this folder moves with it.' : undefined}
          />
        </div>
      </form>
    </Dialog>
  );
}
