import { toFormErrors } from '../../lib/formErrors';
import type { ErrorMapping, FormErrors } from '../../lib/formErrors';

/**
 * File errors are mostly *not* mapped, and that is deliberate.
 *
 * assertValidPath (module 1.5) returns a specific reason for every rejection —
 * "Path must not contain \".\" or \"..\" segments", "Path must use forward
 * slashes", "Path must be at most 32 levels deep". Replacing those with a
 * generic "invalid path" would throw away the most useful text in the system.
 * So the codes below route the server's own message to the path input rather
 * than substituting one.
 *
 * FILE_NOT_FOUND is the exception: "File not found" tells the user nothing
 * about *why*, and the real cause is almost always that someone else deleted it
 * while this tab was open.
 */
const FILE_ERRORS: ErrorMapping = {
  fieldFor: {
    INVALID_PATH: 'path',
    PATH_EXISTS: 'path',
    PARENT_NOT_DIRECTORY: 'path',
    INVALID_MOVE: 'path',
  },
  messages: {
    FILE_NOT_FOUND: 'That file no longer exists. It may have been deleted.',
  },
};

export function toFileFormErrors(error: unknown): FormErrors {
  return toFormErrors(error, FILE_ERRORS);
}

/** For places with no form to attach a field error to — the tree header. */
export function toFileMessage(error: unknown): string {
  const { message, fields } = toFileFormErrors(error);
  return message || Object.values(fields)[0] || 'Something went wrong.';
}

export type { FormErrors };
