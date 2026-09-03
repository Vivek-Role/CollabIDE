import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link, Outlet } from 'react-router';

import { Button, LogoutIcon } from '../components';
import { useAuth } from '../features/auth';

/**
 * The dark IDE chrome: a top bar and a main region.
 *
 * ── The header slot (module 10.3) ──────────────────────────────────────────
 *
 * Before 10.3 a project page drew its OWN bar underneath this one: two stacked
 * bars, ~76px of chrome, no shared alignment. The project context now lives in
 * this header instead — but it is rendered by ProjectPage, through a portal.
 *
 * The portal is the whole point, and it is a correctness requirement rather
 * than a style choice. ProjectHeader needs ProjectPage's state (the project,
 * the rename callback, the member list), so lifting it into this component
 * would mean lifting that state too. Instead this component exposes a DOM node
 * and ProjectPage renders INTO it, staying inside its own React tree.
 *
 * **`<Outlet />` never moves.** It sits in the same position on every render,
 * with the provider wrapped around the whole layout from the very first render
 * so the tree shape never changes. That matters more here than anywhere else in
 * the client: re-parenting the outlet would unmount ProjectPage, and with it
 * every CollabProvider, every Y.Doc and every mounted editor.
 *
 * The slot is held in STATE, not a ref, because a ref does not re-render: the
 * first paint has no element yet, and the consumer must be told when it exists.
 */
const HeaderSlotContext = createContext<HTMLElement | null>(null);

/** The header's breadcrumb region, or null on the first paint. */
export function useHeaderSlot(): HTMLElement | null {
  return useContext(HeaderSlotContext);
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function handleLogout() {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      // logout() always ends the local session, so this component is about to
      // unmount either way; resetting keeps the button honest if it does not.
      setSigningOut(false);
    }
  }

  if (!user) return null;

  /**
   * The avatar is deliberately NOT coloured by `presenceFor`.
   *
   * That would have been a nice touch — the same colour as your caret in the
   * editor — but `presenceFor` is exported from the collab barrel, and that
   * barrel also exports CollabProvider, which pulls in yjs, y-indexeddb,
   * y-protocols and lib0. AppLayout is on the EAGER route, so importing it
   * moved ~98 KB out of the lazy ProjectPage chunk and into the initial bundle:
   * measured 308.86 KB -> 407.23 KB before this was reverted.
   *
   * A deep import that skips the barrel would fix the size and break the
   * project's barrel rule instead, so the avatar simply uses a neutral surface.
   */
  const initial = (user.displayName.trim()[0] ?? user.email[0] ?? '?').toUpperCase();

  return (
    <div ref={container} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.email}`}
        className="flex h-7 w-7 items-center justify-center rounded-full border border-line bg-elevated text-[11px] font-semibold text-ink outline-none transition-colors duration-100 hover:border-line-strong hover:bg-elevated-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
      >
        {initial}
      </button>

      {open ? (
        <div className="absolute right-0 top-9 z-50 w-56 rounded border border-line bg-panel py-1 shadow-panel">
          <p className="truncate px-3 py-2 text-xs text-muted" title={user.email}>
            {user.displayName}
            <span className="block truncate text-[11px] text-muted/80">{user.email}</span>
          </p>
          <div className="my-1 border-t border-line" />
          <div className="px-1 pb-0.5">
            <Button
              variant="ghost"
              size="sm"
              fullWidth
              onClick={handleLogout}
              loading={signingOut}
              className="justify-start"
            >
              <LogoutIcon className="h-3.5 w-3.5" />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AppLayout() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  return (
    <HeaderSlotContext.Provider value={slot}>
      <div className="flex h-full flex-col bg-surface text-ink">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 sm:gap-3 sm:px-4">
          {/* The wordmark is the first thing to go when space is tight — the
              breadcrumb beside it already says where you are. */}
          <Link
            to="/projects"
            className="hidden shrink-0 rounded text-sm font-semibold tracking-tight text-ink outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-panel sm:block"
          >
            collab editor
          </Link>

          {/* Filled by ProjectPage's portal. Empty — and invisible — on every
              other route, which is why there is no placeholder here. */}
          <div ref={setSlot} className="flex min-w-0 flex-1 items-center" />

          <UserMenu />
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </HeaderSlotContext.Provider>
  );
}
