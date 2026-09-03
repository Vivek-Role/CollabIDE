import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { ErrorBoundary } from './app/ErrorBoundary';
import { router } from './app/routes';
import { AuthProvider } from './features/auth';
import './index.css';

const rootElement = document.getElementById('root');

// index.html owns this element. If it is missing, something is wrong with the
// HTML entry itself, and a clear throw beats a blank page.
if (!rootElement) {
  throw new Error('#root is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    {/**
     * AuthProvider sits *above* the router on purpose. The session is not a
     * property of any route — /login reads it to redirect away, RequireAuth
     * reads it to redirect in — and keeping it here means the provider never
     * needs to navigate imperatively. It changes state; the router reacts.
     */}
    {/**
     * The boundary sits outside both, because a failure in AuthProvider itself
     * would otherwise have nothing above it to catch it (module 9.2).
     */}
    <ErrorBoundary>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>,
);
