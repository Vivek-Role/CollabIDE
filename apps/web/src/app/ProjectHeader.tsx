import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';

import {
  Alert,
  Badge,
  Button,
  ChevronRightIcon,
  Dialog,
  Field,
  FolderIcon,
  KeyboardIcon,
  PencilIcon,
  SearchIcon,
  UsersIcon,
} from '../components';
import { toProjectMessage } from '../features/projects';
import type { Role } from '../lib/types';

/**
 * The project's context, rendered into AppLayout's header slot.
 *
 * Extracted from ProjectPage in module 10.3 (decision A1). ProjectPage was 252
 * lines with a "watch it" note against it, and this module adds a breadcrumb, a
 * member count and an overflow menu to exactly this region — which would have
 * put it past the ~300-line guideline.
 *
 * The extraction is a MOVE, not a change of ownership: the rename flow and its
 * state came here because they belong to this markup, while `expanded`,
 * `showMembers` and every file callback stayed in ProjectPage, because the tree
 * and the editor share them. Moving `expanded` in particular would have broken
 * the ancestor-expansion that runs after a file is created.
 *
 * Rename became a dialog rather than the old inline form: a 48px header is the
 * wrong place for a labelled input, and Dialog + Field already exist.
 */
export function ProjectHeader({
  name,
  role,
  memberCount,
  membersOpen,
  onToggleMembers,
  onRename,
  sidebarOpen,
  onToggleSidebar,
  onOpenSearch,
  onOpenShortcuts,
}: {
  name: string;
  role: Role | null;
  memberCount: number;
  membersOpen: boolean;
  onToggleMembers: () => void;
  onRename: (name: string) => Promise<void>;
  /** Below md only — the file tree overlays the editor there (module 10.6). */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Ctrl+K opens the same palette; this is the discoverable way in. */
  onOpenSearch: () => void;
  onOpenShortcuts: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const menu = useRef<HTMLDivElement | null>(null);

  const isOwner = role === 'OWNER';

  useEffect(() => {
    if (!menuOpen) return;

    function onPointerDown(event: MouseEvent) {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  function startRename() {
    setDraft(name);
    setError(null);
    setMenuOpen(false);
    setRenaming(true);
  }

  async function handleRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (draft.trim().length === 0) {
      setError('Project name is required.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await onRename(draft.trim());
      setRenaming(false);
    } catch (caught) {
      setError(toProjectMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      {/* Below md the tree is an overlay, so it needs a way in. Hidden from md
          up, where the sidebar is always on screen. */}
      <Button
        size="sm"
        onClick={onToggleSidebar}
        aria-expanded={sidebarOpen}
        aria-label={sidebarOpen ? 'Hide files' : 'Show files'}
        className="md:hidden"
      >
        <FolderIcon className="h-3.5 w-3.5" />
      </Button>

      {/* The app bar now says where you are, which is what let the project page
          drop its own second bar. */}
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
        <Link
          to="/projects"
          className="hidden shrink-0 rounded text-xs text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-panel sm:inline"
        >
          Projects
        </Link>
        <ChevronRightIcon className="hidden h-3 w-3 shrink-0 text-muted sm:block" />
        <h1 className="truncate text-sm font-semibold text-ink" title={name}>
          {name}
        </h1>
      </nav>

      {role !== null ? (
        <Badge tone={role === 'OWNER' ? 'accent' : 'neutral'} className="hidden sm:inline-flex">
          {role}
        </Badge>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {/* The palette's discoverable entry point. It shows the shortcut rather
            than only answering to it — a keystroke nobody knows about is a
            feature nobody has. */}
        <Button size="sm" onClick={onOpenSearch} aria-label="Search project" title="Search files and contents (Ctrl+K)">
          <SearchIcon className="h-3.5 w-3.5" />
          <span className="hidden lg:inline">Search</span>
          <kbd className="ml-0.5 hidden rounded border border-line px-1 py-px font-mono text-[10px] text-muted lg:inline">
            ⌘K
          </kbd>
        </Button>

        <Button
          size="sm"
          onClick={onToggleMembers}
          aria-expanded={membersOpen}
          aria-label={`Members (${memberCount})`}
        >
          <UsersIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Members</span>
          <span className="ml-0.5 text-muted">{memberCount}</span>
        </Button>

        {/* The menu is no longer owner-only (12.3): it now also holds the
            shortcut list, which everyone needs. Rename inside it stays owner
            -only, and the server enforces that regardless of what is drawn. */}
        <div ref={menu} className="relative">
          <Button
            size="sm"
            onClick={() => setMenuOpen((previous) => !previous)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Project actions"
            title="Project actions"
          >
            <span aria-hidden="true" className="leading-none">
              ⋯
            </span>
          </Button>

          {menuOpen ? (
            <div className="absolute right-0 top-8 z-50 w-52 rounded border border-line bg-panel p-1 shadow-panel">
              {isOwner ? (
                <Button
                  variant="ghost"
                  size="sm"
                  fullWidth
                  onClick={startRename}
                  className="justify-start"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                  Rename project
                </Button>
              ) : null}

              <Button
                variant="ghost"
                size="sm"
                fullWidth
                onClick={() => {
                  setMenuOpen(false);
                  onOpenShortcuts();
                }}
                className="justify-start"
              >
                <KeyboardIcon className="h-3.5 w-3.5" />
                Keyboard shortcuts
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {renaming ? (
        <Dialog
          title="Rename project"
          size="sm"
          onClose={() => (saving ? undefined : setRenaming(false))}
          footer={
            <>
              <Button onClick={() => setRenaming(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" form="rename-project" variant="primary" loading={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          }
        >
          <form id="rename-project" onSubmit={handleRename} noValidate>
            <div className="space-y-4">
              {error !== null ? <Alert>{error}</Alert> : null}

              <Field
                id="project-name"
                label="Name"
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={saving}
              />
            </div>
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}
