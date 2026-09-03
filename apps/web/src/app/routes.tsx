import { Suspense, lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';

import { EmptyState, InboxIcon } from '../components';
import { LoginPage, RegisterPage, RequireAuth } from '../features/auth';
import { ProjectsPage } from '../features/projects';
import { AppLayout } from './AppLayout';
import { RouteErrorPage } from './ErrorBoundary';

/**
 * The route table.
 *
 * The authentication boundary is one visible line — RequireAuth as a layout
 * route — rather than a guard repeated inside each page. Everything nested
 * under it has a session; /login and /register sit outside it and redirect
 * *away* when a session already exists.
 *
 * ProjectPage is the ONLY lazy route (module 9.2), and it is lazy because it is
 * the only one that pulls CodeMirror, Yjs, y-indexeddb and xterm — roughly the
 * whole bundle. /login, /register and /projects need none of that, so without
 * this split every visitor downloads the editor before they can type a password.
 *
 * Lazy loading defers the MODULE, not the mount. The provider's `ready` gate is
 * untouched: EditorPane still refuses to mount the editor until there is a
 * document, so nothing about Phase 5's offline behaviour changes here.
 */
const ProjectPage = lazy(() =>
  import('./ProjectPage').then((module) => ({ default: module.ProjectPage })),
);

function NotFound() {
  return (
    <div className="flex h-full items-center justify-center p-4 sm:p-6">
      <EmptyState
        bordered={false}
        icon={<InboxIcon className="h-6 w-6" />}
        title="Not found"
        hint="That page does not exist."
        action={
          <a
            href="/projects"
            className="inline-flex h-7 items-center justify-center rounded border border-line px-2.5 text-xs font-medium text-ink outline-none transition-colors duration-100 hover:border-line-strong hover:bg-elevated focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Back to projects
          </a>
        }
      />
    </div>
  );
}

/** Shown while the editor chunk downloads. Deliberately quiet: on a warm cache
 *  this is one frame, and a spinner that flashes is worse than nothing. */
function LoadingProject() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className="text-xs text-muted">Loading the editor…</p>
    </div>
  );
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <Navigate to="/projects" replace /> },
      {
        element: <AppLayout />,
        // Anything the router catches inside the shell renders here, in place of
        // the page, with the layout still around it.
        errorElement: <RouteErrorPage />,
        children: [
          { path: '/projects', element: <ProjectsPage /> },
          {
            path: '/projects/:projectId',
            element: (
              <Suspense fallback={<LoadingProject />}>
                <ProjectPage />
              </Suspense>
            ),
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
