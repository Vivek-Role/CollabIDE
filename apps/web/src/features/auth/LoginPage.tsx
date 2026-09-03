import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';

import { Alert, Button, Field } from '../../components';
import { useAuth } from './AuthContext';
import { toAuthFormErrors } from './formErrors';
import type { FormErrors } from './formErrors';

/**
 * Module 10.1 adopts the shared primitives here and NOWHERE else (decision
 * B1-a). This page is the reference implementation: it exercises Button, Field,
 * Alert and the new focus ring against a real form with a real error path,
 * which is how the primitive API gets validated before five more modules depend
 * on it.
 *
 * The change is deliberately narrow — the same markup structure, the same copy,
 * the same layout. Only the local `INPUT_CLASS` string, the two hand-rolled
 * label/input/error blocks and the hand-rolled submit button are gone. The
 * broader auth redesign is module 10.2's, and **no authentication behaviour
 * changed**: the submit handler, the redirect and the error mapping below are
 * byte-for-byte what they were.
 */

/** The route the user was trying to reach before RequireAuth intercepted them. */
function intendedPath(state: unknown): string {
  if (typeof state === 'object' && state !== null && 'from' in state) {
    const { from } = state as { from: unknown };
    // Only same-site paths: an absolute URL here would be an open redirect.
    if (typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')) {
      return from;
    }
  }
  return '/projects';
}

export function LoginPage() {
  const { status, login } = useAuth();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FormErrors>({ message: '', fields: {} });
  const [submitting, setSubmitting] = useState(false);

  // Covers both "already signed in, typed /login" and "just submitted
  // successfully" — login() flips the status and this renders on the next pass.
  if (status === 'authenticated') {
    return <Navigate to={intendedPath(location.state)} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({ message: '', fields: {} });
    setSubmitting(true);

    try {
      await login(email, password);
    } catch (error) {
      setErrors(toAuthFormErrors(error));
      setSubmitting(false);
    }
    // No setSubmitting(false) on success: the redirect above unmounts this.
  }

  return (
    <div className="flex h-full items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold text-ink">Sign in</h1>
        <p className="mb-6 text-xs text-muted">collab editor</p>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {errors.message ? <Alert>{errors.message}</Alert> : null}

          <Field
            id="email"
            name="email"
            type="email"
            label="Email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
            error={errors.fields['email']}
          />

          {/**
           * No minimum length on this form. The server accepts any non-empty
           * password when signing in (schemas.ts) so that a password created
           * before a rule change still works — length rules apply on the way
           * in, not on the way back.
           */}
          <Field
            id="password"
            name="password"
            type="password"
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            error={errors.fields['password']}
          />

          <Button type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-6 text-xs text-muted">
          No account?{' '}
          <Link
            to="/register"
            className="rounded text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
