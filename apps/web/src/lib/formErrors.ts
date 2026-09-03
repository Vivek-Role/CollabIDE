import { ApiError } from './api';

/**
 * Turns a thrown request error into something a form can render.
 *
 * Branching is on the server's machine-readable `code`, never on its message.
 * The message is human text and is free to be reworded; the code is the
 * contract.
 *
 * The generic handling lives here — validation details, unreachable server,
 * unknown codes — and each feature supplies a map for the codes only it cares
 * about. That map is the whole per-feature surface; without it this file would
 * have to know that EMAIL_TAKEN belongs to auth and LAST_OWNER to projects.
 */

export interface FormErrors {
  /** Shown above the form. Empty when every problem was field-specific. */
  message: string;
  /** Keyed by field name, shown under that input. */
  fields: Record<string, string>;
}

export interface ErrorMapping {
  /** code -> banner message. */
  messages?: Record<string, string>;
  /** code -> [field name, message under that input]. */
  fieldMessages?: Record<string, readonly [string, string]>;
  /**
   * code -> field name, keeping **the server's own message**.
   *
   * For INVALID_PATH the server says exactly what is wrong — "Path must not
   * contain \".\" or \"..\" segments", "Path must use forward slashes" — and
   * that text is more useful than any fixed replacement. This routes it to the
   * right input without rewording it.
   */
  fieldFor?: Record<string, string>;
}

const EMPTY: FormErrors = { message: '', fields: {} };

/** VALIDATION_ERROR carries `details: [{ path, message }]` from the server's
 *  zod schema — the one case where a failure maps onto specific inputs. */
function fieldsFromDetails(details: unknown): Record<string, string> {
  if (!Array.isArray(details)) return {};

  const fields: Record<string, string> = {};

  for (const entry of details) {
    if (typeof entry !== 'object' || entry === null) continue;

    const { path, message } = entry as { path?: unknown; message?: unknown };
    if (typeof path === 'string' && typeof message === 'string' && path.length > 0) {
      fields[path] = message;
    }
  }
  return fields;
}

export function toFormErrors(error: unknown, mapping: ErrorMapping = {}): FormErrors {
  if (!(error instanceof ApiError)) {
    return { ...EMPTY, message: 'Something went wrong. Please try again.' };
  }

  if (error.code === 'VALIDATION_ERROR') {
    const fields = fieldsFromDetails(error.details);

    return {
      // Only fall back to a banner if nothing could be attached to an input.
      message: Object.keys(fields).length > 0 ? '' : error.message,
      fields,
    };
  }

  const fieldMessage = mapping.fieldMessages?.[error.code];
  if (fieldMessage) {
    const [field, message] = fieldMessage;
    return { message: '', fields: { [field]: message } };
  }

  const field = mapping.fieldFor?.[error.code];
  if (field) {
    return { message: '', fields: { [field]: error.message } };
  }

  const message = mapping.messages?.[error.code];
  if (message) {
    return { ...EMPTY, message };
  }

  if (error.code === 'NETWORK_ERROR') {
    return { ...EMPTY, message: 'Could not reach the server. Is it running?' };
  }

  /**
   * Unmapped codes fall through to the server's own message. That is what keeps
   * INVALID_CREDENTIALS verbatim: the server returns a byte-identical 401 for
   * "no such account" and "wrong password" and equalises the response time to
   * match (module 1.2). Any friendlier client-side wording would hand back the
   * account-enumeration signal that effort removed, so it must stay unmapped.
   */
  return { ...EMPTY, message: error.message };
}
