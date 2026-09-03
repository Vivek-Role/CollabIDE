/**
 * Demo seeding — two users, one shared project, and files that already contain
 * runnable code.
 *
 *   npm run seed:demo                     # against http://localhost:4000
 *   npm run seed:demo -- --server http://localhost:4001
 *
 * Two rules shape this file (module 9.2, decision D10-B):
 *
 * 1. **Never Prisma, and never an import from apps/**.** It talks to a running
 *    server over exactly the two surfaces a browser uses — REST and the
 *    collaboration WebSocket. `@collab/shared` is fair game and is the reason
 *    the protocol constants below are not hardcoded; it is the contract package
 *    that apps/runner already imports.
 *
 * 2. **File content is written through the real Yjs path, never through REST.**
 *    There is no content field on the file API and no PUT route: module 4.4
 *    removed it because text belongs to the collaboration socket and a REST
 *    write would be silently overwritten by the next flush. So this script
 *    creates the file over REST and then types into it the way a person would.
 *    The server's own 2s flush and File.content materialization make it durable,
 *    which is why the content survives a restart and is visible to the runner.
 *
 * `loadtest/src/client.ts` solves the same socket problem and was read as a
 * reference, deliberately NOT imported: loadtest imports no app and is imported
 * by none, and that holds in both directions.
 *
 * Idempotent. Run it twice and it reuses what exists rather than failing or
 * duplicating; a file that already has content is left alone.
 */

import { MessageType, WS_DOC_PARAM, WS_PATH, Y_TEXT_KEY, makeDocId } from '@collab/shared';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

// ── what gets created ───────────────────────────────────────────────────────

/** Both accounts are EDITORs of the same project, so two browser profiles can
 *  collaborate the moment the seed finishes. Passwords are >= 10 characters
 *  because passwordSchema requires it. */
const USERS = [
  { email: 'demo@example.com', password: 'demo-password', displayName: 'Demo Owner' },
  { email: 'alex@example.com', password: 'demo-password', displayName: 'Alex Editor' },
] as const;

const PROJECT_NAME = 'Demo project';

/** Nested on purpose: a flat list would not show the tree doing anything. */
const FILES: { path: string; content: string }[] = [
  {
    path: 'main.py',
    content: `# The Run button executes this file inside a locked-down container:
# no network, 256 MB, 0.5 CPU, read-only root, non-root user, 10s timeout.
from greet import greeting


def main() -> None:
    for name in ["Ada", "Grace", "Alan"]:
        print(greeting(name))


if __name__ == "__main__":
    main()
`,
  },
  {
    path: 'greet.py',
    content: `def greeting(name: str) -> str:
    return f"Hello, {name}!"
`,
  },
  {
    path: 'main.js',
    content: `// The same sandbox, a different image. Adding a language is one entry in
// packages/shared/src/languages.ts and zero lines of code.
const names = ['Ada', 'Grace', 'Alan'];

for (const name of names) {
  console.log(\`Hello, \${name}!\`);
}
`,
  },
  {
    path: 'notes/README.md',
    content: `# Demo project

Open the same file in two browser profiles and type in both — the carets are
live and the text converges.

Then go offline in DevTools, keep typing, and come back.
`,
  },
];

// ── plumbing ────────────────────────────────────────────────────────────────

class SeedError extends Error {}

function parseServer(argv: string[]): string {
  const at = argv.indexOf('--server');
  const value = at === -1 ? undefined : argv[at + 1];
  return (value ?? process.env.SEED_SERVER ?? 'http://localhost:4000').replace(/\/$/, '');
}

/** Only the name=value pair travels back; the flags are the server's business. */
function sessionCookie(response: Response): string {
  const session = response.headers.getSetCookie().find((v) => v.startsWith('ce_session='));
  if (!session) throw new SeedError('The server set no ce_session cookie');
  return session.split(';')[0] ?? '';
}

/**
 * No Origin header is sent, and none is needed: originCheck allows a missing
 * Origin and rejects only a mismatched one, which is what lets curl and
 * server-to-server calls work. The WebSocket handshake has the identical shape.
 */
async function call(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new SeedError(
      `Could not reach ${baseUrl}. Is the server running? (npm run dev:server)`,
    );
  }
  return response;
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    throw new SeedError(`${what} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

// ── REST: users, project, membership, files ─────────────────────────────────

/** Registers, or logs in if the account is already there. Either way we end up
 *  with a session, which is what makes re-running this safe. */
async function ensureUser(
  baseUrl: string,
  user: (typeof USERS)[number],
): Promise<{ cookie: string; created: boolean }> {
  const registered = await call(baseUrl, 'POST', '/api/auth/register', { body: user });
  if (registered.ok) return { cookie: sessionCookie(registered), created: true };

  const login = await call(baseUrl, 'POST', '/api/auth/login', {
    body: { email: user.email, password: user.password },
  });
  if (login.ok) return { cookie: sessionCookie(login), created: false };

  throw new SeedError(
    `Could not register or log in ${user.email}. ` +
      `Register said ${registered.status}; login said ${login.status} ${await login.text()}`,
  );
}

interface ProjectRow {
  id: string;
  name: string;
}

async function ensureProject(baseUrl: string, cookie: string): Promise<ProjectRow> {
  const listed = await json<{ projects: ProjectRow[] }>(
    await call(baseUrl, 'GET', '/api/projects', { cookie }),
    'Listing projects',
  );

  const existing = listed.projects.find((p) => p.name === PROJECT_NAME);
  if (existing) return existing;

  const created = await json<{ project: ProjectRow }>(
    await call(baseUrl, 'POST', '/api/projects', { body: { name: PROJECT_NAME }, cookie }),
    'Creating the project',
  );
  return created.project;
}

/** By email, never by id: ids are opaque and are not a thing a person types. */
async function ensureMember(
  baseUrl: string,
  cookie: string,
  projectId: string,
  email: string,
): Promise<void> {
  const response = await call(baseUrl, 'POST', `/api/projects/${projectId}/members`, {
    body: { email, role: 'EDITOR' },
    cookie,
  });

  // Already a member is success as far as this script is concerned.
  if (response.ok || response.status === 409) return;

  throw new SeedError(`Adding ${email} failed: ${response.status} ${await response.text()}`);
}

interface TreeNode {
  id: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

async function ensureFile(
  baseUrl: string,
  cookie: string,
  projectId: string,
  path: string,
): Promise<{ id: string; created: boolean }> {
  const { tree } = await json<{ tree: TreeNode[] }>(
    await call(baseUrl, 'GET', `/api/projects/${projectId}/files`, { cookie }),
    'Listing files',
  );

  const existing = flatten(tree).find((node) => node.path === path && !node.isDir);
  if (existing) return { id: existing.id, created: false };

  // Intermediate directories are created by the server, so notes/README.md is
  // one request and two rows.
  const created = await json<{ file: { id: string } }>(
    await call(baseUrl, 'POST', `/api/projects/${projectId}/files`, {
      body: { path, isDir: false },
      cookie,
    }),
    `Creating ${path}`,
  );
  return { id: created.file.id, created: true };
}

/** File.content is derived state written by the persistence module — reading it
 *  back is how we know whether a file already has text. */
async function readContent(
  baseUrl: string,
  cookie: string,
  projectId: string,
  fileId: string,
): Promise<string> {
  const { file } = await json<{ file: { content: string } }>(
    await call(baseUrl, 'GET', `/api/projects/${projectId}/files/${fileId}`, { cookie }),
    'Reading file content',
  );
  return file.content;
}

// ── the Yjs write (D10-B) ───────────────────────────────────────────────────

const REMOTE = 'remote';

function toWsUrl(baseUrl: string, docId: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = WS_PATH;
  url.searchParams.set(WS_DOC_PARAM, docId);
  return url.toString();
}

/**
 * Types `content` into a document over the real collaboration socket.
 *
 * The sequence matters:
 *
 *   open -> send sync step 1 -> the server answers step 2 with the document
 *   -> only NOW do we know whether it is empty -> insert -> the doc's update
 *   observer sends it -> wait for the socket's buffer to drain -> close.
 *
 * Closing is what makes it durable: this is the room's last connection, so
 * leaveRoom runs the final flush, one DocUpdate row is written, and
 * File.content is materialized on the following tick. Nothing here writes to
 * the database, and nothing here needs to.
 */
async function seedContent(
  baseUrl: string,
  cookie: string,
  docId: string,
  content: string,
): Promise<'written' | 'already had content'> {
  const doc = new Y.Doc();
  const ytext = doc.getText(Y_TEXT_KEY);
  const socket = new WebSocket(toWsUrl(baseUrl, docId), { headers: { cookie } });

  const send = (message: Uint8Array): void => {
    if (socket.readyState === socket.OPEN) socket.send(message);
  };

  const sync = (write: (encoder: encoding.Encoder) => void): void => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);
    write(encoder);
    send(encoding.toUint8Array(encoder));
  };

  // Without this guard every update we apply is echoed straight back.
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    sync((encoder) => syncProtocol.writeUpdate(encoder, update));
  });

  let settleSynced: (() => void) | undefined;
  let failSynced: ((error: Error) => void) | undefined;
  const synced = new Promise<void>((resolve, reject) => {
    settleSynced = resolve;
    failSynced = reject;
  });

  socket.on('open', () => sync((encoder) => syncProtocol.writeSyncStep1(encoder, doc)));

  socket.on('message', (data: Buffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(decoder) !== MessageType.Sync) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);
    const kind = syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE);
    if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder));

    // Step 2 carries the server's document state. Once it has been applied we
    // are looking at the real file, so "is it empty?" is finally a fair question.
    if (kind === syncProtocol.messageYjsSyncStep2) settleSynced?.();
  });

  socket.on('close', (code: number) => {
    if (code !== 1000 && code !== 1005) {
      failSynced?.(new SeedError(`The collaboration socket closed with code ${code}`));
    }
  });

  socket.on('error', (error: Error) => failSynced?.(new SeedError(error.message)));

  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));

  try {
    await withTimeout(synced, 10_000, `syncing ${docId}`);

    if (ytext.length > 0) return 'already had content';

    ytext.insert(0, content);

    // The update was handed to the socket synchronously by the observer above;
    // this waits for the bytes to actually leave.
    await drain(socket);
    return 'written';
  } finally {
    socket.close();
    await withTimeout(closed, 5_000, `closing ${docId}`).catch(() => undefined);
    doc.destroy();
  }
}

async function drain(socket: WebSocket): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (socket.bufferedAmount > 0 && Date.now() < deadline) {
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SeedError(`Timed out ${what} after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const baseUrl = parseServer(process.argv.slice(2));
  console.log(`Seeding the demo against ${baseUrl}\n`);

  const [owner, editor] = USERS;

  const ownerSession = await ensureUser(baseUrl, owner);
  const editorSession = await ensureUser(baseUrl, editor);
  console.log(
    `  users     ${owner.email} (${ownerSession.created ? 'created' : 'existing'}), ` +
      `${editor.email} (${editorSession.created ? 'created' : 'existing'})`,
  );

  const project = await ensureProject(baseUrl, ownerSession.cookie);
  await ensureMember(baseUrl, ownerSession.cookie, project.id, editor.email);
  console.log(`  project   ${project.name} (${project.id}), ${editor.email} added as EDITOR`);

  for (const file of FILES) {
    const { id, created } = await ensureFile(baseUrl, ownerSession.cookie, project.id, file.path);

    // Cheap pre-check: a file the persistence layer has already materialized
    // needs no socket at all.
    const materialized = await readContent(baseUrl, ownerSession.cookie, project.id, id);
    if (materialized.length > 0) {
      console.log(`  file      ${file.path} — already had content`);
      continue;
    }

    const result = await seedContent(
      baseUrl,
      ownerSession.cookie,
      makeDocId(project.id, id),
      file.content,
    );
    console.log(`  file      ${file.path} — ${created ? 'created, ' : ''}${result}`);
  }

  // The flush is debounced by 2s and File.content is materialized on the tick
  // after the append. Waiting here means the summary below is not a promise
  // about something still in flight.
  console.log('\n  waiting for the server flush (2s debounce)…');
  await sleep(4_000);

  const check = await readContent(
    baseUrl,
    ownerSession.cookie,
    project.id,
    (await ensureFile(baseUrl, ownerSession.cookie, project.id, 'main.py')).id,
  );

  console.log(
    check.length > 0
      ? '  persisted  main.py content is materialized into File.content\n'
      : '  WARNING    main.py is still empty — the flush may not have completed\n',
  );

  console.log('Done. Log in at http://localhost:5173\n');
  for (const user of USERS) {
    console.log(`  ${user.email.padEnd(18)} ${user.password}`);
  }
  console.log(`\n  Project: http://localhost:5173/projects/${project.id}`);
  console.log('  Open it in two browser profiles to see live collaboration.\n');
}

main().catch((error: unknown) => {
  console.error(`\nSeeding failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
