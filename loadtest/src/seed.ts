import type { RunConfig } from './config.js';

/**
 * Everything the run needs, created through the REST API exactly as a browser
 * would create it.
 *
 * Never Prisma. CLAUDE.md's invariant is that Prisma is imported only in
 * apps/server, and the server's own test/helpers/projects.ts seeds through it
 * precisely because it lives inside that workspace. This does not.
 *
 * No Origin header is sent, and none is needed: originCheck.ts allows a missing
 * Origin and rejects only a mismatched one ("curl, server-to-server calls and
 * older clients simply do not send one"). The WebSocket handshake in
 * wsServer.ts has the identical shape.
 */

export interface Seeded {
  projectId: string;
  fileIds: string[];
  /** One cookie per user. With the default --users 1 this is the owner's, and
   *  every client shares it — see the note below. */
  cookies: string[];
}

const PASSWORD = 'loadtest-correct-horse';

export class SeedError extends Error {}

function sessionCookie(response: Response): string {
  const session = response.headers.getSetCookie().find((value) => value.startsWith('ce_session='));
  if (!session) throw new SeedError('No ce_session cookie was set');

  // Only the name=value pair travels back; the flags are the server's business.
  return session.split(';')[0] ?? '';
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) headers['cookie'] = cookie;

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new SeedError(`POST ${path} -> ${response.status} ${await response.text()}`);
  }
  return response;
}

/**
 * Seeds against the FIRST server only. Under two instances both share one
 * database, so the project exists for both — and creating everything in one
 * place is also what keeps the cold-open race below from being manufactured.
 */
export async function seed(config: RunConfig): Promise<Seeded> {
  const baseUrl = config.servers[0];
  if (baseUrl === undefined) throw new SeedError('No server URL to seed against');

  // Unique per run, so repeated runs never collide on the email constraint.
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const owner = await post(baseUrl, '/api/auth/register', {
    email: `loadtest-${stamp}-0@example.com`,
    password: PASSWORD,
    displayName: 'Loadtest Owner',
  });
  const ownerCookie = sessionCookie(owner);

  const project = await post(baseUrl, '/api/projects', { name: `loadtest ${stamp}` }, ownerCookie);
  const projectId = ((await project.json()) as { project: { id: string } }).project.id;

  const fileIds: string[] = [];
  for (let i = 0; i < config.docs; i += 1) {
    const file = await post(
      baseUrl,
      `/api/projects/${projectId}/files`,
      { path: `load-${i + 1}.txt`, isDir: false },
      ownerCookie,
    );
    fileIds.push(((await file.json()) as { file: { id: string } }).file.id);
  }

  /**
   * Default: one owner account for every virtual client (Phase 8 decision G).
   * Authorization resolves once at join and each client has its own Y.Doc — and
   * therefore its own client id — so N clients on one account load the socket,
   * room registry, bus and database exactly as N accounts would. Only the
   * awareness payload would differ, and this harness publishes none. Module 8.3
   * discloses this so the numbers never read as N real humans.
   */
  const cookies = [ownerCookie];

  for (let i = 1; i < config.users; i += 1) {
    const email = `loadtest-${stamp}-${i}@example.com`;
    const member = await post(baseUrl, '/api/auth/register', {
      email,
      password: PASSWORD,
      displayName: `Loadtest User ${i}`,
    });

    // By email, never userId: ids are opaque and are not a thing a user types.
    await post(baseUrl, `/api/projects/${projectId}/members`, { email, role: 'EDITOR' }, ownerCookie);
    cookies.push(sessionCookie(member));
  }

  return { projectId, fileIds, cookies };
}
