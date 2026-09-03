import { Navigate, Outlet, useLocation } from 'react-router';

import { useAuth } from './AuthContext';

/**
 * The authentication boundary, as a layout route: everything nested under it
 * requires a session.
 *
 * While the status is 'loading' this renders nothing. That is the whole trick —
 * redirecting before /auth/me has answered would throw a signed-in user out to
 * /login on every page refresh.
 *
 * The attempted location rides along in redirect state so LoginPage can return
 * the user where they were actually going, instead of always dropping them on
 * /projects.
 *
 * This is a convenience, not a security control. The server authorizes every
 * request on its own (requireAuth, and assertProjectAccess from module 1.3);
 * removing this component would make the app unusable, not insecure.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return null;
  }

  if (status === 'anonymous') {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }

  return <Outlet />;
}
