import { useState } from 'react';
import { Link } from 'react-router';

import { Alert, Badge, Button, Dialog, TrashIcon } from '../../components';
import type { Role } from '../../lib/types';
import { toProjectMessage } from './errors';
import type { ProjectListItem } from './useProjects';

/** Replaces the local ROLE_CLASS map — the Badge tones say the same thing, and
 *  the editor's status bar (10.4) reuses the same vocabulary. */
/**
 * "3 minutes ago", falling back to a date once that stops being useful.
 *
 * Intl.RelativeTimeFormat is in every browser this app already requires and
 * needs no dependency. The absolute date stays in the title attribute, because
 * a relative label is easier to read and impossible to cite.
 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  const seconds = Math.round((then - Date.now()) / 1000);
  const absolute = Math.abs(seconds);

  // Past a week the reader wants the date, not an ever-growing 'N days ago'.
  if (absolute > 7 * 86400) return new Date(iso).toLocaleDateString();

  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (absolute < 60) return format.format(Math.round(seconds), 'second');
  if (absolute < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86400), 'day');
}

const ROLE_TONE: Record<Role, 'accent' | 'neutral'> = {
  OWNER: 'accent',
  EDITOR: 'neutral',
  VIEWER: 'neutral',
};

export function ProjectCard({
  project,
  onDelete,
}: {
  project: ProjectListItem;
  onDelete: (projectId: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);

    try {
      await onDelete(project.id);
      setConfirming(false);
    } catch (caught) {
      setError(toProjectMessage(caught));
      setDeleting(false);
    }
  }

  return (
    <div className="flex items-center justify-between rounded border border-line bg-panel px-4 py-3 transition-colors duration-100 hover:border-line-strong hover:bg-elevated">
      <div className="min-w-0">
        <Link
          to={`/projects/${project.id}`}
          className="rounded text-sm font-medium text-ink outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          {project.name}
        </Link>
        {/* Only what the list route actually returns (decision A4): there is no
            file count on ProjectListResponse, and inventing one would mean a
            server change this phase does not make. */}
        <p
          className="mt-0.5 text-[11px] text-muted"
          title={new Date(project.updatedAt).toLocaleString()}
        >
          Updated {relativeTime(project.updatedAt)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <Badge tone={ROLE_TONE[project.role]}>{project.role}</Badge>

        {/* Owner-only, and only cosmetically: DELETE /projects/:id is guarded by
            requireProjectRole('OWNER') whatever the client renders. */}
        {project.role === 'OWNER' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${project.name}`}
            title={`Delete ${project.name}`}
            className="hover:text-danger"
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>

      {confirming ? (
        <Dialog
          title="Delete project"
          onClose={() => (deleting ? undefined : setConfirming(false))}
          footer={
            <>
              <Button onClick={() => setConfirming(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleDelete} loading={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            {/* Names the project and states the blast radius: the server
                cascades to members and files, and nothing here is undoable. */}
            <p className="text-sm text-ink">
              Delete <span className="font-medium">{project.name}</span>?
            </p>
            <p className="text-xs text-muted">
              Every file in it and every member’s access go with it. This cannot be undone.
            </p>

            {error ? <Alert>{error}</Alert> : null}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
