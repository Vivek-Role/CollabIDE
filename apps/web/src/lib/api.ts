/**
 * The only place in the app that calls fetch().
 *
 * Everything else goes through `api`. That is what makes the WebSocket URL in
 * module 3.2 a one-line addition, and what gives module 2.1b a single place to
 * notice a 401.
 *
 * Requests go to the same origin as the page (/api/...) and Vite proxies them
 * to :4000 in dev. Without that proxy the SameSite=Strict session cookie is
 * never sent — see vite.config.ts.
 */

/**
 * Every server error is `{ error: { code, message, details? } }` with a stable
 * machine-readable code. The UI branches on `code`, never on `message`: the
 * message is human text and is free to be reworded.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Present on VALIDATION_ERROR: [{ path, message }] per failed field. */
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const BASE = '/api';

/**
 * Notified whenever a request comes back 401, so a session that expires or is
 * revoked mid-use is noticed wherever it happens rather than at whichever call
 * site remembered to check.
 *
 * This file stays transport-only: it reports the failure and takes no view on
 * what it means. The auth feature decides — it is the thing that knows
 * UNAUTHENTICATED ("your session is gone") differs from INVALID_CREDENTIALS
 * ("that login attempt was wrong"), which share the same status code.
 */
type UnauthorizedHandler = (error: ApiError) => void;

let unauthorizedHandler: UnauthorizedHandler | undefined;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | undefined): void {
  unauthorizedHandler = handler;
}

/** Pulls code + message out of the error envelope, tolerating a body that is
 *  not JSON at all — a proxy or a crash can produce HTML here, and "Unexpected
 *  token <" is a much worse thing to show a user than a generic message. */
function toApiError(status: number, payload: unknown): ApiError {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const { error } = payload as { error: unknown };

    if (typeof error === 'object' && error !== null) {
      const { code, message, details } = error as {
        code?: unknown;
        message?: unknown;
        details?: unknown;
      };

      return new ApiError(
        status,
        typeof code === 'string' ? code : 'UNKNOWN',
        typeof message === 'string' ? message : 'Request failed',
        details,
      );
    }
  }

  return new ApiError(status, 'UNKNOWN', 'Request failed');
}

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      // Same-origin in dev thanks to the proxy, so this is belt and braces —
      // but it is also what keeps the client honest if the API ever moves.
      credentials: 'include',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // fetch only rejects when the request never completed: server down,
    // DNS, connection reset. A 500 is a resolved promise.
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server');
  }

  // 204 from logout and the delete routes — no body to parse.
  if (response.status === 204) {
    return undefined as T;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const error = toApiError(response.status, payload);

    if (response.status === 401) {
      unauthorizedHandler?.(error);
    }
    throw error;
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body),
  delete: <T>(path: string): Promise<T> => request<T>('DELETE', path),
};
