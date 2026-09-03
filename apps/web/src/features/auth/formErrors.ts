import { toFormErrors } from '../../lib/formErrors';
import type { ErrorMapping, FormErrors } from '../../lib/formErrors';

/**
 * The auth-specific half of error rendering. The generic half — validation
 * details, unreachable server, unknown codes — lives in lib/formErrors.ts.
 *
 * INVALID_CREDENTIALS is deliberately absent: leaving it unmapped means the
 * server's own message is shown verbatim, and the client never says whether an
 * email address is registered. See the note at the bottom of lib/formErrors.ts.
 */
const AUTH_ERRORS: ErrorMapping = {
  fieldMessages: {
    EMAIL_TAKEN: ['email', 'That email is already registered.'],
  },
};

export function toAuthFormErrors(error: unknown): FormErrors {
  return toFormErrors(error, AUTH_ERRORS);
}

export type { FormErrors };
