import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api, setUnauthorizedHandler } from '../../lib/api';
import type { User, UserResponse } from '../../lib/types';

/**
 * Who is signed in, and the only place that changes.
 *
 * The session cookie is httpOnly, so JavaScript cannot read it — by design.
 * That means the server is the only thing that actually knows whether you are
 * signed in, and this context is a cache of its answer, refreshed from
 * GET /api/auth/me on mount. Nothing is written to localStorage: a copy of the
 * user there would be a second source of truth, and it would be the stale one.
 *
 * The provider deliberately performs no navigation. It sits above the router in
 * main.tsx and only owns state; RequireAuth and the two auth pages turn that
 * state into redirects by rendering <Navigate>. That is what makes "a 401
 * anywhere sends you back to login" fall out with no imperative code: the
 * status flips to anonymous and the route tree re-renders itself.
 */

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthValue {
  user: User | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  /**
   * Starts at 'loading', never at 'anonymous'.
   *
   * Anything that redirects on 'anonymous' would fire during the first render —
   * before /auth/me has answered — and throw a signed-in user out to /login on
   * every refresh. The third state exists solely to make that impossible.
   */
  const [status, setStatus] = useState<AuthStatus>('loading');

  // Bootstrap. A 401 here is not an error: it is the ordinary answer for
  // someone who is not signed in.
  useEffect(() => {
    let cancelled = false;

    api
      .get<UserResponse>('/auth/me')
      .then((response) => {
        if (cancelled) return;
        setUser(response.user);
        setStatus('authenticated');
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setStatus('anonymous');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * A 401 from any request at all — the 7-day token expiring mid-session, or a
   * user row deleted underneath a live tab — drops the session here, and the
   * router does the rest.
   *
   * Only UNAUTHENTICATED counts. INVALID_CREDENTIALS is also a 401 but means
   * "that login attempt failed", and treating it as a lost session would clear
   * state the user never had.
   */
  useEffect(() => {
    setUnauthorizedHandler((error) => {
      if (error.code !== 'UNAUTHENTICATED') return;
      setUser(null);
      setStatus('anonymous');
    });

    return () => setUnauthorizedHandler(undefined);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const response = await api.post<UserResponse>('/auth/login', { email, password });
    setUser(response.user);
    setStatus('authenticated');
  }, []);

  const register = useCallback(
    async (email: string, password: string, displayName: string) => {
      const response = await api.post<UserResponse>('/auth/register', {
        email,
        password,
        displayName,
      });
      setUser(response.user);
      setStatus('authenticated');
    },
    [],
  );

  const logout = useCallback(async () => {
    // The server clears the cookie; this only clears the local mirror of it.
    // In `finally` because a failed request must not leave the UI claiming a
    // session the user has already decided to end.
    try {
      await api.post<void>('/auth/logout');
    } finally {
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ user, status, login, register, logout }),
    [user, status, login, register, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return value;
}
