import { makeDocId } from '@collab/shared';

import { prisma } from '../../db.js';
import { AppError } from '../../http/errors.js';
// Through the barrel only, and one way: collab imports nothing from here.
import { closeFileRooms } from '../collab/index.js';
import { docStore } from '../persistence/index.js';
import {
  ancestorPaths,
  assertValidPath,
  baseName,
  isDescendantOf,
  replacePathPrefix,
} from './paths.js';

/**
 * File rules for a project.
 *
 * Rows are flat — each carries its full path — and the tree is assembled in
 * memory. For a project-sized tree that is one indexed query and an O(n) pass,
 * which beats a recursive CTE, and it keeps `@@unique([projectId, path])` as
 * the single collision guard.
 *
 * Prefix matching is done in JavaScript rather than SQL `LIKE`: a path may
 * legitimately contain `%` or `_`, and those are wildcards to LIKE. Loading the
 * project's rows and filtering here removes that whole class of bug.
 */

const FILE_FIELDS = {
  id: true,
  path: true,
  isDir: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface FileRecord {
  id: string;
  path: string;
  isDir: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TreeNode extends FileRecord {
  name: string;
  children: TreeNode[];
}

// ── Tree ────────────────────────────────────────────────────────────────────

/** Directories before files, then alphabetical — the order a file explorer
 *  shows, decided once here rather than in every client. */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function buildTree(rows: FileRecord[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();

  for (const row of rows) {
    nodes.set(row.path, { ...row, name: baseName(row.path), children: [] });
  }

  const roots: TreeNode[] = [];

  for (const node of nodes.values()) {
    const parent = node.path.includes('/')
      ? nodes.get(node.path.slice(0, node.path.lastIndexOf('/')))
      : undefined;

    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  for (const node of nodes.values()) node.children.sort(compareNodes);
  roots.sort(compareNodes);

  return roots;
}

export async function listTree(projectId: string): Promise<TreeNode[]> {
  const rows = await prisma.file.findMany({
    where: { projectId },
    select: FILE_FIELDS,
    orderBy: { path: 'asc' },
  });

  return buildTree(rows);
}

/**
 * Every runnable file in the project, as plain text, for module 6.6's run
 * payload.
 *
 * One query rather than listTree + readFile per file, which would be an N+1 for
 * exactly what a single findMany returns. Directories are excluded: `docker cp`
 * recreates the tree from the file paths.
 *
 * `content` is derived state written only by modules/persistence (4.4), and it
 * can lag the update log by one flush interval — which is why the execution
 * service flushes before calling this.
 */
export async function listFilesForRun(
  projectId: string,
): Promise<{ path: string; content: string }[]> {
  return prisma.file.findMany({
    where: { projectId, isDir: false },
    select: { path: true, content: true },
    orderBy: { path: 'asc' },
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function findInProject(projectId: string, fileId: string) {
  const file = await prisma.file.findFirst({
    where: { id: fileId, projectId },
    select: { ...FILE_FIELDS, content: true },
  });

  // Scoped by projectId as well as id: a file id from another project must not
  // resolve just because the caller can read *some* project.
  if (!file) throw new AppError(404, 'FILE_NOT_FOUND', 'File not found');
  return file;
}

export async function readFile(
  projectId: string,
  fileId: string,
): Promise<FileRecord & { content: string }> {
  const file = await findInProject(projectId, fileId);

  if (file.isDir) {
    throw new AppError(400, 'IS_DIRECTORY', 'That path is a directory, not a file');
  }
  return file;
}

// ── Writes ──────────────────────────────────────────────────────────────────

export async function createFile(
  projectId: string,
  rawPath: string,
  isDir: boolean,
): Promise<FileRecord> {
  const path = assertValidPath(rawPath);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.file.findUnique({
      where: { projectId_path: { projectId, path } },
      select: { id: true },
    });
    if (existing) throw new AppError(409, 'PATH_EXISTS', 'Something already exists at that path');

    /**
     * Missing parent directories are created implicitly. The alternative —
     * making the client walk the path and create each level — makes module
     * 2.3's file tree much worse for no benefit.
     */
    for (const ancestor of ancestorPaths(path)) {
      const row = await tx.file.findUnique({
        where: { projectId_path: { projectId, path: ancestor } },
        select: { isDir: true },
      });

      if (!row) {
        await tx.file.create({ data: { projectId, path: ancestor, isDir: true } });
      } else if (!row.isDir) {
        throw new AppError(409, 'PARENT_NOT_DIRECTORY', `"${ancestor}" is a file, not a directory`);
      }
    }

    return tx.file.create({ data: { projectId, path, isDir }, select: FILE_FIELDS });
  });
}

export async function moveFile(
  projectId: string,
  fileId: string,
  rawPath: string,
): Promise<FileRecord> {
  const newPath = assertValidPath(rawPath);

  return prisma.$transaction(async (tx) => {
    const file = await tx.file.findFirst({
      where: { id: fileId, projectId },
      select: FILE_FIELDS,
    });
    if (!file) throw new AppError(404, 'FILE_NOT_FOUND', 'File not found');

    if (file.path === newPath) return file;

    // Moving a directory inside itself would orphan the whole subtree — the
    // rows would still exist but be unreachable from any root.
    if (file.isDir && isDescendantOf(newPath, file.path)) {
      throw new AppError(409, 'INVALID_MOVE', 'Cannot move a directory inside itself');
    }

    const all = await tx.file.findMany({
      where: { projectId },
      select: { id: true, path: true, isDir: true },
    });

    const moving = file.isDir
      ? all.filter((row) => row.id === file.id || isDescendantOf(row.path, file.path))
      : [file];

    const movingIds = new Set(moving.map((row) => row.id));
    const targets = new Map(
      moving.map((row) => [
        row.id,
        row.id === file.id ? newPath : replacePathPrefix(row.path, file.path, newPath),
      ]),
    );

    // Collision against anything that is not itself being moved.
    const occupied = new Set(all.filter((row) => !movingIds.has(row.id)).map((row) => row.path));
    for (const target of targets.values()) {
      if (occupied.has(target)) {
        throw new AppError(409, 'PATH_EXISTS', 'Something already exists at that path');
      }
    }

    for (const ancestor of ancestorPaths(newPath)) {
      const row = all.find((candidate) => candidate.path === ancestor);
      if (!row) {
        await tx.file.create({ data: { projectId, path: ancestor, isDir: true } });
      } else if (!row.isDir) {
        throw new AppError(409, 'PARENT_NOT_DIRECTORY', `"${ancestor}" is a file, not a directory`);
      }
    }

    for (const [id, path] of targets) {
      await tx.file.update({ where: { id }, data: { path } });
    }

    return { ...file, path: newPath };
  });
}

export async function deleteFile(projectId: string, fileId: string): Promise<number> {
  const deleted = await prisma.$transaction(async (tx) => {
    const file = await tx.file.findFirst({
      where: { id: fileId, projectId },
      select: { id: true, path: true, isDir: true },
    });
    if (!file) throw new AppError(404, 'FILE_NOT_FOUND', 'File not found');

    if (!file.isDir) {
      await tx.file.delete({ where: { id: file.id } });
      return [file.id];
    }

    const all = await tx.file.findMany({ where: { projectId }, select: { id: true, path: true } });
    const doomed = all
      .filter((row) => row.id === file.id || isDescendantOf(row.path, file.path))
      .map((row) => row.id);

    await tx.file.deleteMany({ where: { id: { in: doomed } } });
    return doomed;
  });

  // Anyone editing one of these is holding a socket onto a row that is gone —
  // for a directory, that is every descendant too (module 3.4b). The ids are
  // collected inside the transaction because afterwards there is nothing to walk.
  await closeFileRooms(deleted);

  // DocUpdate/DocSnapshot key on a string docId, not a foreign key, so the
  // cascade does not reach them.
  //
  // Known limitation: closing a socket runs its room teardown asynchronously, so
  // a final flush can land just after this and leave orphan rows. They are
  // unreadable — the File row is gone, so createRoom returns null — and bounded
  // by "a socket was open at the moment of deletion". Fixing it properly means
  // making revocation awaitable, which is its own module.
  await Promise.all(deleted.map((id) => docStore.deleteDoc(makeDocId(projectId, id))));

  return deleted.length;
}
