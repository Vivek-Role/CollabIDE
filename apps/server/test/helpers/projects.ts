import type { Role } from '@prisma/client';

import { prisma } from '../../src/db.js';

/**
 * Projects are created straight through Prisma here because the projects API
 * does not exist until module 1.4. Once it does, 1.4's own tests drive the
 * routes; these helpers stay as the cheap way for other modules to get a
 * project without going through HTTP.
 */

export async function createProject(ownerId: string, name = 'Test project'): Promise<string> {
  const project = await prisma.project.create({
    data: {
      name,
      ownerId,
      // The OWNER membership is what authorization actually reads — a project
      // without it is a project its own creator cannot open.
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
    select: { id: true },
  });
  return project.id;
}

export async function addMember(projectId: string, userId: string, role: Role): Promise<void> {
  await prisma.projectMember.create({ data: { projectId, userId, role } });
}
