import type { Role } from '@prisma/client';

import { prisma } from '../../db.js';
import { AppError } from '../../http/errors.js';

/**
 * Project rules. Knows nothing about HTTP — no `req`, no `res`, no status codes
 * beyond the AppError it throws. routes.ts does parse -> authorize -> call this
 * -> shape the response, which keeps both files small and this one testable on
 * its own.
 */

const PROJECT_FIELDS = {
  id: true,
  name: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface ProjectSummary {
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemberSummary {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
}

export async function createProject(userId: string, name: string): Promise<ProjectSummary> {
  /**
   * The project row and its OWNER membership are written together. Prisma runs
   * a nested create in one transaction, which matters: a project without its
   * OWNER row is a project nobody can open — including the person who just
   * made it. This is the only place that invariant can be broken.
   */
  return prisma.project.create({
    data: {
      name,
      ownerId: userId,
      members: { create: { userId, role: 'OWNER' } },
    },
    select: PROJECT_FIELDS,
  });
}

export async function listProjects(
  userId: string,
): Promise<Array<ProjectSummary & { role: Role }>> {
  // Driven from the membership table, so a project you are not in cannot appear
  // even by accident.
  const memberships = await prisma.projectMember.findMany({
    where: { userId },
    select: { role: true, project: { select: PROJECT_FIELDS } },
    orderBy: { project: { updatedAt: 'desc' } },
  });

  return memberships.map(({ role, project }) => ({ ...project, role }));
}

export async function getProject(
  projectId: string,
): Promise<{ project: ProjectSummary; members: MemberSummary[] }> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: PROJECT_FIELDS,
  });

  const members = await prisma.projectMember.findMany({
    where: { projectId },
    select: {
      role: true,
      user: { select: { id: true, email: true, displayName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return {
    project,
    members: members.map(({ role, user }) => ({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role,
    })),
  };
}

export async function renameProject(projectId: string, name: string): Promise<ProjectSummary> {
  return prisma.project.update({
    where: { id: projectId },
    data: { name },
    select: PROJECT_FIELDS,
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  // Memberships and files go with it via onDelete: Cascade (module 1.1).
  // DocUpdate/DocSnapshot key on a string docId rather than a foreign key, so
  // Phase 4 will clean those up here explicitly.
  await prisma.project.delete({ where: { id: projectId } });
}

// ── Membership ──────────────────────────────────────────────────────────────

async function countOwners(projectId: string): Promise<number> {
  return prisma.projectMember.count({ where: { projectId, role: 'OWNER' } });
}

export async function addMember(
  projectId: string,
  email: string,
  role: Role,
): Promise<MemberSummary> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, displayName: true },
  });

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'No account exists for that email');
  }

  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
    select: { id: true },
  });

  if (existing) {
    throw new AppError(409, 'ALREADY_MEMBER', 'That user is already a member of this project');
  }

  await prisma.projectMember.create({ data: { projectId, userId: user.id, role } });

  return { userId: user.id, email: user.email, displayName: user.displayName, role };
}

export async function changeMemberRole(
  projectId: string,
  userId: string,
  role: Role,
): Promise<MemberSummary> {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true, user: { select: { id: true, email: true, displayName: true } } },
  });

  if (!member) {
    throw new AppError(404, 'MEMBER_NOT_FOUND', 'That user is not a member of this project');
  }

  // Demoting the only OWNER would leave a project nobody can administer —
  // cheaper to refuse than to build a recovery path for it.
  if (member.role === 'OWNER' && role !== 'OWNER' && (await countOwners(projectId)) === 1) {
    throw new AppError(409, 'LAST_OWNER', 'A project must always have at least one owner');
  }

  await prisma.projectMember.update({
    where: { projectId_userId: { projectId, userId } },
    data: { role },
  });

  return {
    userId: member.user.id,
    email: member.user.email,
    displayName: member.user.displayName,
    role,
  };
}

export async function removeMember(
  projectId: string,
  userId: string,
  actingUserId: string,
): Promise<void> {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });

  if (!member) {
    throw new AppError(404, 'MEMBER_NOT_FOUND', 'That user is not a member of this project');
  }

  // Removing yourself is almost always a slip, and for a sole owner it is
  // unrecoverable. "Leave project" can be its own explicit route later.
  if (userId === actingUserId) {
    throw new AppError(409, 'CANNOT_REMOVE_SELF', 'You cannot remove yourself from a project');
  }

  if (member.role === 'OWNER' && (await countOwners(projectId)) === 1) {
    throw new AppError(409, 'LAST_OWNER', 'A project must always have at least one owner');
  }

  await prisma.projectMember.delete({
    where: { projectId_userId: { projectId, userId } },
  });
}
