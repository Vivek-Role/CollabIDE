import { useMemo, useState } from 'react';

import {
  Alert,
  Button,
  CloseIcon,
  EmptyState,
  InboxIcon,
  PlusIcon,
  SearchIcon,
} from '../../components';
import { CreateProjectDialog } from './CreateProjectDialog';
import { ProjectCard } from './ProjectCard';
import { useProjects } from './useProjects';

/** Three placeholder rows at the height of a real card. A skeleton is only
 *  honest if it matches what replaces it; otherwise the page jumps. */
function SkeletonRows() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="animate-pulse rounded border border-line bg-panel px-4 py-3">
          <div className="h-4 w-40 rounded bg-elevated" />
          <div className="mt-2 h-3 w-24 rounded bg-elevated" />
        </div>
      ))}
    </div>
  );
}

export function ProjectsPage() {
  const { projects, loading, error, createProject, deleteProject } = useProjects();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');

  const query = filter.trim();

  /**
   * A plain substring test, and deliberately NOT the search feature's
   * `matchPath`.
   *
   * ProjectsPage is on the EAGER route, and importing the search barrel here
   * pulls SearchPalette and its hook into the initial chunk with it — measured
   * 312.69 kB -> 326.08 kB before this was reverted. It is the same trap module
   * 10.4 hit with `presenceFor` in AppLayout, at a smaller scale.
   *
   * The cost is that a project name is matched by substring while a file path
   * is also matched as a subsequence. For a short, human-chosen project name
   * that is the behaviour people expect anyway.
   */
  const visible = useMemo(() => {
    if (projects === null) return null;
    if (query.length === 0) return projects;

    const needle = query.toLowerCase();
    return projects.filter((project) => project.name.toLowerCase().includes(needle));
  }, [projects, query]);

  // Only once there are enough projects that scanning the list is real work.
  const showFilter = (projects?.length ?? 0) > 2;

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="text-base font-semibold text-ink">
            Projects
            {projects && projects.length > 0 ? (
              <span className="ml-2 text-xs font-normal text-muted">{projects.length}</span>
            ) : null}
          </h1>
          <Button variant="primary" size="md" onClick={() => setCreating(true)}>
            <PlusIcon className="h-3.5 w-3.5" />
            New project
          </Button>
        </div>

        {showFilter ? (
          <div className="relative mb-4">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            />
            <input
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setFilter('');
              }}
              placeholder="Filter projects"
              aria-label="Filter projects by name"
              className="h-9 w-full rounded border border-line bg-panel pl-9 pr-9 text-[13px] text-ink outline-none transition-colors duration-100 placeholder:text-muted hover:border-line-strong focus-visible:ring-2 focus-visible:ring-focus"
            />
            {filter.length > 0 ? (
              <button
                type="button"
                onClick={() => setFilter('')}
                aria-label="Clear filter"
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted outline-none transition-colors duration-100 hover:bg-elevated hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
              >
                <CloseIcon className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        ) : null}

        {loading ? <SkeletonRows /> : null}

        {/* An unreachable server must say so. A blank page here is the single
            most confusing state this screen can be in. */}
        {!loading && error ? <Alert>{error}</Alert> : null}

        {/* The first thing a new account ever sees, so it is part of the module
            rather than polish deferred to Phase 9. */}
        {!loading && !error && projects?.length === 0 ? (
          <EmptyState
            icon={<InboxIcon className="h-6 w-6" />}
            title="No projects yet"
            hint="Create one to start writing code."
            action={
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                New project
              </Button>
            }
          />
        ) : null}

        {!loading && !error && visible?.length === 0 && (projects?.length ?? 0) > 0 ? (
          <EmptyState
            icon={<SearchIcon className="h-6 w-6" />}
            title="No projects match"
            hint={`Nothing you can open is called “${query}”.`}
            action={
              <Button size="sm" onClick={() => setFilter('')}>
                Clear filter
              </Button>
            }
          />
        ) : null}

        {!loading && !error && visible && visible.length > 0 ? (
          <div className="space-y-2">
            {/* Server order (updatedAt desc) is kept as-is — if it is ever
                wrong, that is a server fix, not a client sort. Filtering
                preserves it, because Array.filter does. */}
            {visible.map((project) => (
              <ProjectCard key={project.id} project={project} onDelete={deleteProject} />
            ))}
          </div>
        ) : null}
      </div>

      {creating ? (
        <CreateProjectDialog onCreate={createProject} onClose={() => setCreating(false)} />
      ) : null}
    </div>
  );
}
