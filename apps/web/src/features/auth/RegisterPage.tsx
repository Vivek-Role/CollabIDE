import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate } from 'react-router';

import { Alert, Button, Field } from '../../components';
import { useAuth } from './AuthContext';
import { toAuthFormErrors } from './formErrors';
import type { FormErrors } from './formErrors';

/**
 * Mirrors the server's rule (schemas.ts: passwordSchema) so the user hears about
 * a short password before a round trip. The server remains the authority — if
 * these two ever disagree its VALIDATION_ERROR details are rendered instead.
 */
const MIN_PASSWORD_LENGTH = 10;

export function RegisterPage() {
  const { status, register } = useAuth();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FormErrors>({ message: '', fields: {} });
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated') {
    return <Navigate to="/projects" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const fields: Record<string, string> = {};
    if (displayName.trim().length === 0) {
      fields['displayName'] = 'Display name is required.';
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      fields['password'] = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }

    if (Object.keys(fields).length > 0) {
      setErrors({ message: '', fields });
      return;
    }

    setErrors({ message: '', fields: {} });
    setSubmitting(true);

    try {
      await register(email, password, displayName.trim());
    } catch (error) {
      setErrors(toAuthFormErrors(error));
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold text-ink">Create an account</h1>
        <p className="mb-6 text-xs text-muted">collab editor</p>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {errors.message ? <Alert>{errors.message}</Alert> : null}

          <Field
            id="displayName"
            name="displayName"
            type="text"
            label="Display name"
            autoComplete="nickname"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            disabled={submitting}
            error={errors.fields['displayName']}
          />

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

          {/* The hint is the field's own, and Field drops it while an error is
              showing — the same precedence the hand-rolled markup had. */}
          <Field
            id="password"
            name="password"
            type="password"
            label="Password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            error={errors.fields['password']}
            hint={`At least ${MIN_PASSWORD_LENGTH} characters. Length beats symbols.`}
          />

          <Button type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
            {submitting ? 'Creating account…' : 'Create account'}
          </Button>
        </form>

        <p className="mt-6 text-xs text-muted">
          Already have an account?{' '}
          <Link
            to="/login"
            className="rounded text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
