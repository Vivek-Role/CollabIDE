import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router';

import { Alert, Dialog } from '../components';
import { EditorPane, useOpenFiles } from '../features/editor';
import type { RevealRequest } from '../features/editor';
import { RunPanel } from '../features/terminal';
import { FileTree, ancestorPaths, subtreeIds, useFileTree } from '../features/files';
import { MembersPanel, useProjectDetail } from '../features/projects';
import { SearchPalette, flattenTree } from '../features/search';
import type { FlatNode, PaletteMode, RevealTarget } from '../features/search';
import { useHeaderSlot } from './AppLayout';
import { ProjectHeader } from './ProjectHeader';
import { ShortcutsDialog } from './ShortcutsDialog';

/**
 * A single project: file tree on the left, work area on the right.
 *
 * Expand and select state live here rather than inside the tree, so they
 * survive every refetch and so module 2.4 can turn a selection into an open
 * editor tab without reaching into the sidebar.
 *
 * Module 10.3 moved the project's own header bar into AppLayout's header,
 * through a portal (see AppLayout's header-slot comment). ProjectHeader is
 * still rendered from here, so it still reads this component's state — only its
 * pixels move. **The rest of this tree is untouched**, which is what keeps the
 * editor and its collaboration providers mounted across that change.
 *
 * Module 12.1 added the search palette and the keyboard shortcuts that open it.
 * Both are siblings of the layout, not wrappers around it, for the same reason:
 * anything that re-parents `<main>` unmounts every CollabProvider under it.
 */
export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? '';

  const detail = useProjectDetail(id);
  const files = useFileTree(id);
  // Tab labels only. The text of each open file lives in its Yjs document,
  // owned by the collab provider EditorPane holds (module 3.5).
  const editor = useOpenFiles();
  const headerSlot = useHeaderSlot();

  /**
   * Folders are tracked by path, not id: it is what "the folder I opened" means
   * to a person, and it makes expanding the ancestors of a new file a string
   * operation rather than a lookup into a tree that has not arrived yet.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showMembers, setShowMembers] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  /** Null when the palette is closed; the mode it was opened in otherwise. */
  const [palette, setPalette] = useState<PaletteMode | null>(null);

  /**
   * Where a search result asked the editor to put the cursor. Kept here rather
   * than inside the editor because the palette lives here — and because the
   * file may not be open yet when the request is made, in which case it is
   * consumed by CodeMirror on mount.
   */
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const revealNonce = useRef(0);

  /**
   * Only meaningful below `md` (module 10.6). At `md` and above the sidebar is
   * always in the layout and this flag does nothing — the CSS decides, not a
   * branch, which is what keeps the editor subtree identical at every width.
   */
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /**
   * The `md`-and-up counterpart, added in 12.3 so Ctrl+B means something on a
   * desktop too. It collapses the aside's WIDTH; the element, the tree and its
   * state all stay mounted, so nothing is refetched and no editor is disturbed.
   */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    if (!sidebarOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setSidebarOpen(false);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarOpen]);

  const canEdit = detail.role === 'OWNER' || detail.role === 'EDITOR';

  const nodes = useMemo(() => flattenTree(files.tree), [files.tree]);

  /** Recently opened files, resolved against the tree as it is NOW — which is
   *  what silently drops anything that has since been deleted or renamed. */
  const recent = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));

    return editor.recentIds
      .map((fileId) => byId.get(fileId))
      .filter((node): node is FlatNode => node !== undefined);
  }, [editor.recentIds, nodes]);

  const toggleSidebar = useCallback(() => {
    // One shortcut, two layouts: below `md` the tree is an overlay and "toggle"
    // means slide it in; from `md` up it is part of the layout and "toggle"
    // means give its width to the editor.
    const wide =
      typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;

    if (wide) setSidebarCollapsed((previous) => !previous);
    else setSidebarOpen((previous) => !previous);
  }, []);

  /** The one global keymap. Everything here preventDefaults, because every
   *  binding it claims is one the browser or the OS would otherwise take. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;

      if (mod && !event.shiftKey && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        setPalette('all');
        return;
      }

      if (mod && !event.shiftKey && (event.key === 'p' || event.key === 'P')) {
        event.preventDefault();
        setPalette('files');
        return;
      }

      if (mod && event.shiftKey && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        setPalette('all');
        return;
      }

      if (mod && (event.key === 'b' || event.key === 'B')) {
        event.preventDefault();
        toggleSidebar();
        return;
      }

      // A bare `?` is only a shortcut when it is not being typed INTO
      // something. Every other binding above carries a modifier and is safe.
      if (event.key === '?' && !mod) {
        const target = event.target as HTMLElement | null;
        const typing =
          target?.tagName === 'INPUT' ||
          target?.tagName === 'TEXTAREA' ||
          target?.isContentEditable === true;

        if (!typing) {
          event.preventDefault();
          setShowShortcuts(true);
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar]);

  const toggle = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /** Open a file and, if the result was a text match, ask the editor to go to
   *  it. Also reveals the file in the tree, so the sidebar agrees with the
   *  editor about where you are. */
  const openFromSearch = useCallback(
    (node: FlatNode, target?: RevealTarget) => {
      editor.openFile(node);

      setExpanded((previous) => {
        const next = new Set(previous);
        for (const ancestor of ancestorPaths(node.path)) next.add(ancestor);
        return next;
      });

      if (target) {
        revealNonce.current += 1;
        setReveal({
          docId: node.id,
          line: target.line,
          text: target.text,
          nonce: revealNonce.current,
        });
      }

      setSidebarOpen(false);
    },
    [editor],
  );

  const createNode = useCallback(
    async (path: string, isDir: boolean) => {
      const created = await files.createNode(path, isDir);
      // Without this, creating src/main.py in an empty project leaves src/
      // collapsed and the new file invisible — the request succeeded and the
      // user sees nothing.
      setExpanded((previous) => {
        const next = new Set(previous);
        for (const ancestor of ancestorPaths(created.path)) next.add(ancestor);
        if (created.isDir) next.add(created.path);
        return next;
      });
    },
    [files],
  );

  const moveNode = useCallback(
    async (fileId: string, path: string) => {
      const moved = await files.moveNode(fileId, path);
      setExpanded((previous) => {
        const next = new Set(previous);
        for (const ancestor of ancestorPaths(moved.path)) next.add(ancestor);
        return next;
      });
      // The row keeps its id across a move, so an open tab follows its file.
      editor.renameTab(moved.id, moved.path);
    },
    [files, editor],
  );

  const deleteNode = useCallback(
    async (fileId: string) => {
      // Collected FIRST: deleteNode refetches, and afterwards the subtree is no
      // longer in the tree to walk. For a file this is just its own id.
      const removed = subtreeIds(files.tree, fileId);

      const deleted = await files.deleteNode(fileId);

      // Closing these is not cosmetic: a directory takes everything beneath it
      // with it on the server, so its descendants' tabs go too.
      for (const id of removed) editor.closeFile(id);

      return deleted;
    },
    [files, editor],
  );

  if (detail.loading) {
    return <p className="px-6 py-6 text-xs text-muted">Loading…</p>;
  }

  // A non-member gets 404 rather than 403 from the server, so project existence
  // stays private. This says the same thing either way, on purpose.
  if (detail.error || !detail.project) {
    return (
      <div className="mx-6 my-6">
        <Alert>{detail.error ?? 'That project could not be loaded.'}</Alert>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Painted into AppLayout's header, but still this component's child —
          so it reads `detail` directly and nothing had to be lifted. */}
      {headerSlot
        ? createPortal(
            <ProjectHeader
              name={detail.project.name}
              role={detail.role}
              memberCount={detail.members.length}
              membersOpen={showMembers}
              onToggleMembers={() => setShowMembers((previous) => !previous)}
              onRename={detail.rename}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((previous) => !previous)}
              onOpenSearch={() => setPalette('all')}
              onOpenShortcuts={() => setShowShortcuts(true)}
            />,
            headerSlot,
          )
        : null}

      <div className="relative flex min-h-0 flex-1">
        {/* Dims the editor behind the overlaid sidebar. A SIBLING of <aside>,
            never a wrapper around <main> — wrapping would re-parent the editor
            and tear down every CollabProvider under it. */}
        {sidebarOpen ? (
          <div
            aria-hidden="true"
            onClick={() => setSidebarOpen(false)}
            className="absolute inset-0 z-30 bg-black/60 md:hidden"
          />
        ) : null}

        {/**
         * One <aside>, one position in the tree, at every width. Below `md` it
         * is taken out of flow and slid in with a transform; from `md` up the
         * max-md: rules simply do not apply and it is an ordinary flex child.
         *
         * Deliberately NOT two branches: rendering a different tree per
         * breakpoint would remount the sidebar — and, if the split were drawn
         * any higher, the editor with it. The `md` collapse added in 12.3 is a
         * width change for the same reason: the subtree must survive it.
         */}
        <aside
          className={[
            'w-64 shrink-0 border-r border-line bg-panel',
            'transition-transform duration-150 md:transition-none',
            'max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40',
            sidebarOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full',
            sidebarCollapsed ? 'md:w-0 md:overflow-hidden md:border-r-0' : 'md:w-56 lg:w-64',
          ].join(' ')}
        >
          <FileTree
            tree={files.tree}
            loading={files.loading}
            error={files.error}
            canEdit={canEdit}
            expanded={expanded}
            selectedId={editor.activeId}
            onToggle={toggle}
            onSelect={(node) => {
              editor.openFile(node);
              // Below md the sidebar covers the editor, so opening a file and
              // leaving it open would hide the thing you just asked for.
              setSidebarOpen(false);
            }}
            onCreate={createNode}
            onMove={moveNode}
            onDelete={deleteNode}
            onOpenSearch={() => setPalette('all')}
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <EditorPane
              projectId={id}
              tabs={editor.tabs}
              activeId={editor.activeId}
              readOnly={!canEdit}
              reveal={reveal}
              onSelectTab={editor.setActiveId}
              onCloseTab={editor.closeFile}
            />
          </div>

          {/* The run panel is a sibling of the editor, not a tenant: it talks
              to /run and /runs/:jobId/stream over SSE and never touches the
              collaboration socket. */}
          <RunPanel
            projectId={id}
            entrypoint={editor.tabs.find((tab) => tab.id === editor.activeId)?.path ?? null}
            canEdit={canEdit}
          />
        </main>
      </div>

      {/* A dialog rather than a panel that swaps out the main pane: members are
          consulted occasionally, and losing sight of the file you are editing
          to check them is a poor trade. */}
      {showMembers ? (
        <Dialog title="Members" size="lg" onClose={() => setShowMembers(false)}>
          <MembersPanel
            members={detail.members}
            role={detail.role}
            onInvite={detail.invite}
            onChangeRole={detail.changeRole}
            onRemove={detail.removeMember}
          />
        </Dialog>
      ) : null}

      {palette !== null ? (
        <SearchPalette
          projectId={id}
          tree={files.tree}
          mode={palette}
          recent={recent}
          onOpen={openFromSearch}
          onClose={() => setPalette(null)}
        />
      ) : null}

      {showShortcuts ? <ShortcutsDialog onClose={() => setShowShortcuts(false)} /> : null}
    </div>
  );
}
