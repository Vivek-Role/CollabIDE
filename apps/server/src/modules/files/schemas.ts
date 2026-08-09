import { z } from 'zod';

/**
 * Shape only. The path *rules* live in paths.ts and are applied by the service,
 * so REST and any future caller enforce exactly the same thing.
 */

export const createFileSchema = z.object({
  path: z.string(),
  isDir: z.boolean().default(false),
});

export const writeFileSchema = z.object({
  // No length cap here: the 1mb express.json limit already bounds it, and a
  // real source file has no business-level maximum.
  content: z.string(),
});

export const moveFileSchema = z.object({
  path: z.string(),
});
