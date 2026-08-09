import { z } from 'zod';

export const roleSchema = z.enum(['OWNER', 'EDITOR', 'VIEWER']);

export const projectNameSchema = z
  .string()
  .trim()
  .min(1, 'Project name is required')
  .max(100, 'Project name must be at most 100 characters');

export const createProjectSchema = z.object({
  name: projectNameSchema,
});

export const renameProjectSchema = z.object({
  name: projectNameSchema,
});

/**
 * Members are invited by email, never by user id. Ids are opaque and are never
 * exposed for lookup; the inviter already knows the address they are typing, so
 * confirming whether it has an account tells them nothing they did not have.
 */
export const addMemberSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(254),
  role: roleSchema,
});

export const changeRoleSchema = z.object({
  role: roleSchema,
});
