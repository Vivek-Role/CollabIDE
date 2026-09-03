import { z } from 'zod';

/**
 * Shape only. The path *rules* live in paths.ts and are applied by the service,
 * so REST and any future caller enforce exactly the same thing.
 */

export const createFileSchema = z.object({
  path: z.string(),
  isDir: z.boolean().default(false),
});

export const moveFileSchema = z.object({
  path: z.string(),
});
