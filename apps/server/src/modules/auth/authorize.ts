import type { Role } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { prisma } from '../../db.js';
import { AppError } from '../../http/errors.js';
import { currentUser } from './requireAuth.js';

/**
 * Project authorization — the single place that decides whether a user may
 * touch a project.
 *
 * `assertProjectAccess` takes plain strings and returns plain data: no `req`,
 * no `res`, no Express. That is deliberate and is the whole reason this is its
 * own module. Module 3.4 calls it during a **WebSocket upgrade**, where there
 * is no Express request to hand it. The middleware below is a thin adapter for
 * the REST side, and the only express import in this file is `import type`,
 * which disappears at compile time — so the compiled authorize.js pulls in no
 * HTTP machinery at all.
 *
 * Invariant (CLAUDE.md): enforced server-side, never trusted from the client.
 */

/** Privilege ordering lives here, not in SQL. Typed as Record<Role, number> so
 *  adding a role to the schema fails to compile until it is ranked. */
export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 0,
  EDITOR: 1,
  OWNER: 2,
};

export interface ProjectAccess {
  projectId: string;
  userId: string;
  role: Role;
}

export function hasRole(actual: Role, minimum: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[minimum];
}

/**
 * 404 rather than 403 when you are not a member.
 *
 * A 403 would confirm the project exists, which lets anyone walk project ids
 * and learn what other people are working on. 403 is reserved for the case
 * where you *are* a member and simply are not senior enough — there the
 * existence of the project is already known to you, so nothing leaks.
 *
 * A project that does not exist and a project you cannot see return the exact
 * same response.
 */
const notFound = () =>
  new AppError(404, 'PROJECT_NOT_FOUND', 'Project not found');

export async function assertProjectAccess(
  userId: string,
  projectId: string,
  minRole: Role,
): Promise<ProjectAccess> {
  // One indexed lookup on @@unique([projectId, userId]). No caching: a stale
  // permission is a security bug, and this is a single primary-key-shaped read.
  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { projectId: true, userId: true, role: true },
  });

  if (!membership) throw notFound();

  if (!hasRole(membership.role, minRole)) {
    throw new AppError(403, 'FORBIDDEN', `This action requires the ${minRole} role`);
  }

  return membership;
}

// ── Express adapter ─────────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      projectAccess?: ProjectAccess;
    }
  }
}

/**
 * Use after `requireAuth`. Reads the project id from the route parameter —
 * `:id` on /api/projects/:id (1.4), `:projectId` on the nested file routes
 * (1.5) — and stashes the membership so the handler gets the role for free.
 */
export function requireProjectRole(minRole: Role, param = 'projectId') {
  return async function projectRoleGuard(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { id: userId } = currentUser(req);
      const projectId = req.params[param];

      if (typeof projectId !== 'string' || projectId.length === 0) {
        throw notFound();
      }

      req.projectAccess = await assertProjectAccess(userId, projectId, minRole);
      next();
    } catch (error) {
      next(error);
    }
  };
}
