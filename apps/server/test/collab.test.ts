import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { CloseCode, WS_PATH, Y_TEXT_KEY, makeDocId } from '@collab/shared';

import { docStore } from '../src/modules/persistence/index.js';

import { prisma, resetDb } from './helpers/db.js';
import { createTestApp } from './helpers/app.js';
import { registerUser, type SignedInUser } from './helpers/auth.js';
import { addMember, createProject } from './helpers/projects.js';
// Straight to the services, as paths.test.ts does: these are the functions
// module 3.4b hooks into, and the routes that wrap them are already covered.
import { deleteFile } from '../src/modules/files/service.js';
import { changeMemberRole, deleteProject, removeMember } from '../src/modules/projects/service.js';
import {
  connect,
  connectYjs,
  settle,
  startWsServer,
  waitFor,
  type WsTestServer,
  type YClient,
} from './helpers/ws.js';

/**
 * Module 3.2 — the handshake only.
 *
 * The doc id here is well-formed but points at nothing: whether the project and
 * file exist, and whether the user may open them, is module 3.4's job. These
 * tests must keep passing unchanged when it lands.
 */

let server: WsTestServer;
let alice: SignedInUser;

const DOC = makeDocId('cmea1x4k80000ab12cd34ef56', 'cmea1x4k80001ab12gh78ij90');

function url(query = `?doc=${DOC}`): string {
  return `${server.url}${WS_PATH}${query}`;
}

beforeAll(async () => {
  server = await startWsServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetDb();
  alice = await registerUser(createTestApp());
});

describe('websocket handshake', () => {
  it('accepts an authenticated upgrade for a well-formed doc id', async () => {
    const result = await connect(url(), { cookie: alice.cookie });

    expect(result.opened).toBe(true);
    // The handshake passed. DOC names a project that does not exist, so module
    // 3.4's authorization then closes it — the same answer a non-member gets.
    expect(result.code).toBe(CloseCode.NotFound);
  });

  it('refuses a connection with no cookie', async () => {
    const result = await connect(url());
    expect(result.code).toBe(CloseCode.Unauthenticated);
  });

  it('refuses a garbage cookie exactly as it refuses no cookie', async () => {
    const result = await connect(url(), { cookie: 'ce_session=not-a-real-token' });
    expect(result.code).toBe(CloseCode.Unauthenticated);
  });

  it('refuses a token for a user that no longer exists', async () => {
    const cookie = alice.cookie;
    await resetDb(); // the token stays valid; the row does not

    const result = await connect(url(), { cookie });
    expect(result.code).toBe(CloseCode.Unauthenticated);
  });

  it('refuses an upgrade with no doc id', async () => {
    const result = await connect(url(''), { cookie: alice.cookie });
    expect(result.code).toBe(CloseCode.BadRequest);
  });

  it('refuses a malformed doc id', async () => {
    const result = await connect(url('?doc=nonsense'), { cookie: alice.cookie });
    expect(result.code).toBe(CloseCode.BadRequest);
  });

  it('refuses a foreign origin', async () => {
    const result = await connect(url(), {
      cookie: alice.cookie,
      origin: 'http://evil.example.com',
    });
    expect(result.code).toBe(CloseCode.BadRequest);
  });

  it('accepts the allowed origin', async () => {
    const result = await connect(url(), {
      cookie: alice.cookie,
      origin: 'http://localhost:5173',
    });
    expect(result.opened).toBe(true);
    // Past the origin check and into authorization, as above.
    expect(result.code).toBe(CloseCode.NotFound);
  });

  it('does not upgrade a path it does not own', async () => {
    const result = await connect(`${server.url}/nope?doc=${DOC}`, { cookie: alice.cookie });
    expect(result.opened).toBe(false);
  });
});

/** Module 3.4a — sync, awareness, and who is allowed to write. */
describe('collaboration', () => {
  let bob: SignedInUser;
  let projectId: string;
  let fileId: string;
  const clients: YClient[] = [];

  function open(user: SignedInUser, file = fileId, project = projectId): YClient {
    const client = connectYjs(
      `${server.url}${WS_PATH}?doc=${makeDocId(project, file)}`,
      user.cookie,
    );
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    // alice and the reset happen in the outer beforeEach.
    bob = await registerUser(createTestApp());
    projectId = await createProject(alice.user.id);

    const file = await prisma.file.create({
      data: { projectId, path: 'main.py', content: 'hello' },
      select: { id: true },
    });
    fileId = file.id;
    clients.length = 0;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await settle(50);
  });

  it('delivers one client’s edit to another', async () => {
    await addMember(projectId, bob.user.id, 'EDITOR');

    const a = open(alice);
    const b = open(bob);
    await waitFor(() => a.text() === 'hello' && b.text() === 'hello');

    a.doc.getText(Y_TEXT_KEY).insert(0, 'A ');

    await waitFor(() => b.text() === 'A hello');
  });

  it('converges when two clients type at the same offset', async () => {
    await addMember(projectId, bob.user.id, 'EDITOR');

    const a = open(alice);
    const b = open(bob);
    await waitFor(() => a.text() === 'hello' && b.text() === 'hello');

    a.doc.getText(Y_TEXT_KEY).insert(0, 'AAA');
    b.doc.getText(Y_TEXT_KEY).insert(0, 'BBB');

    await waitFor(() => a.text() === b.text() && a.text().length === 11);
    // Nothing lost and nothing duplicated — both halves survive, in one order.
    expect(a.text()).toContain('AAA');
    expect(a.text()).toContain('BBB');
    expect(a.text()).toContain('hello');
  });

  it('gives a late joiner the current document', async () => {
    await addMember(projectId, bob.user.id, 'EDITOR');

    const a = open(alice);
    await waitFor(() => a.text() === 'hello');
    a.doc.getText(Y_TEXT_KEY).insert(0, 'early ');
    await settle(100);

    const b = open(bob);
    await waitFor(() => b.text() === 'early hello');
  });

  it('refuses a non-member with the same answer as a nonexistent project', async () => {
    const outsider = open(bob);
    expect(await outsider.closed).toBe(CloseCode.NotFound);

    const ghost = open(alice, fileId, 'cmea1x4k80000ab12cd34ef56');
    expect(await ghost.closed).toBe(CloseCode.NotFound);
  });

  it('lets a VIEWER read but drops what it writes', async () => {
    await addMember(projectId, bob.user.id, 'VIEWER');

    const a = open(alice);
    const viewer = open(bob);
    await waitFor(() => viewer.text() === 'hello');

    viewer.doc.getText(Y_TEXT_KEY).insert(0, 'sneaky ');
    await settle();

    // The write never reached the room, so the other client never saw it...
    expect(a.text()).toBe('hello');
    // ...and the socket stays open rather than being closed as an error.
    expect(viewer.socket.readyState).toBe(viewer.socket.OPEN);
  });

  it('lets an EDITOR write in the same situation', async () => {
    await addMember(projectId, bob.user.id, 'EDITOR');

    const a = open(alice);
    const editor = open(bob);
    await waitFor(() => editor.text() === 'hello');

    editor.doc.getText(Y_TEXT_KEY).insert(0, 'allowed ');

    await waitFor(() => a.text() === 'allowed hello');
  });

  it('relays awareness to the other client and not back to the sender', async () => {
    await addMember(projectId, bob.user.id, 'EDITOR');

    const a = open(alice);
    const b = open(bob);
    await waitFor(() => a.text() === 'hello' && b.text() === 'hello');

    a.awareness.setLocalState({ name: 'Alice', color: '#ff0000' });

    await waitFor(() => b.awareness.getStates().size === 1);
    expect([...b.awareness.getStates().values()][0]).toEqual({ name: 'Alice', color: '#ff0000' });
    // The sender holds only its own state — the relay did not come back to it.
    expect(a.awareness.getStates().size).toBe(1);
  });

  it('removes a disconnected client’s cursor', async () => {
    await addMember(projectId, bob.user.id, 'EDITOR');

    const a = open(alice);
    const b = open(bob);
    await waitFor(() => a.text() === 'hello' && b.text() === 'hello');

    b.awareness.setLocalState({ name: 'Bob', color: '#00ff00' });
    await waitFor(() => a.awareness.getStates().size === 1);

    b.close();
    await waitFor(() => a.awareness.getStates().size === 0);
  });

  it('closes the socket on a text frame', async () => {
    await addMember(projectId, bob.user.id, 'EDITOR');

    const a = open(alice);
    await waitFor(() => a.text() === 'hello');

    a.socket.send('not binary');

    expect(await a.closed).toBe(CloseCode.BadRequest);
  });

  /** Module 3.4b — a socket is authorized once, so access changes must close it. */
  describe('access changes while connected', () => {
    it('closes a demoted member’s socket, and readmits them read-only', async () => {
      await addMember(projectId, bob.user.id, 'EDITOR');
      const editor = open(bob);
      await waitFor(() => editor.text() === 'hello');

      await changeMemberRole(projectId, bob.user.id, 'VIEWER');
      expect(await editor.closed).toBe(CloseCode.Gone);

      const viewer = open(bob);
      const alice2 = open(alice);
      await waitFor(() => viewer.text() === 'hello' && alice2.text() === 'hello');

      viewer.doc.getText(Y_TEXT_KEY).insert(0, 'nope ');
      await settle();
      expect(alice2.text()).toBe('hello');
    });

    it('closes a promoted member’s socket, so they can write after reconnecting', async () => {
      await addMember(projectId, bob.user.id, 'VIEWER');
      const viewer = open(bob);
      await waitFor(() => viewer.text() === 'hello');

      await changeMemberRole(projectId, bob.user.id, 'EDITOR');
      expect(await viewer.closed).toBe(CloseCode.Gone);

      const editor = open(bob);
      const watcher = open(alice);
      await waitFor(() => editor.text() === 'hello' && watcher.text() === 'hello');

      editor.doc.getText(Y_TEXT_KEY).insert(0, 'now allowed ');
      await waitFor(() => watcher.text() === 'now allowed hello');
    });

    it('closes only the removed member’s socket', async () => {
      await addMember(projectId, bob.user.id, 'EDITOR');
      const owner = open(alice);
      const member = open(bob);
      await waitFor(() => owner.text() === 'hello' && member.text() === 'hello');

      await removeMember(projectId, bob.user.id, alice.user.id);

      expect(await member.closed).toBe(CloseCode.Gone);
      expect(owner.socket.readyState).toBe(owner.socket.OPEN);
    });

    it('persists what a member typed before being demoted', async () => {
      await addMember(projectId, bob.user.id, 'EDITOR');
      const editor = open(bob);
      await waitFor(() => editor.text() === 'hello');

      editor.doc.getText(Y_TEXT_KEY).insert(0, 'their work ');
      await settle(100);

      await changeMemberRole(projectId, bob.user.id, 'VIEWER');
      await editor.closed;
      await settle(200);

      // Losing a demoted user's text would be a punishment, not a permission.
      // Module 4.3 moved that durability from File.content into the update log.
      const loaded = await docStore.load(makeDocId(projectId, fileId));
      const doc = new Y.Doc();
      if (loaded.snapshot) Y.applyUpdate(doc, loaded.snapshot);
      for (const update of loaded.updates) Y.applyUpdate(doc, update);

      expect(doc.getText(Y_TEXT_KEY).toString()).toBe('their work hello');
    });

    it('closes every socket in a deleted project', async () => {
      await addMember(projectId, bob.user.id, 'EDITOR');
      const owner = open(alice);
      const member = open(bob);
      await waitFor(() => owner.text() === 'hello' && member.text() === 'hello');

      await deleteProject(projectId);

      expect(await owner.closed).toBe(CloseCode.Gone);
      expect(await member.closed).toBe(CloseCode.Gone);
    });

    it('closes the sockets of a deleted file', async () => {
      const editing = open(alice);
      await waitFor(() => editing.text() === 'hello');

      await deleteFile(projectId, fileId);

      expect(await editing.closed).toBe(CloseCode.Gone);
    });

    it('closes the sockets of files inside a deleted directory', async () => {
      const nested = await prisma.file.create({
        data: { projectId, path: 'src/deep.py', content: 'nested' },
        select: { id: true },
      });
      const dir = await prisma.file.create({
        data: { projectId, path: 'src', isDir: true },
        select: { id: true },
      });

      const editing = open(alice, nested.id);
      await waitFor(() => editing.text() === 'nested');

      await deleteFile(projectId, dir.id);

      expect(await editing.closed).toBe(CloseCode.Gone);
    });
  });
});
