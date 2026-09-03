import { z } from 'zod';

/**
 * The run request body.
 *
 * Only the entrypoint: the client says WHICH file to run and nothing else. It
 * never sends a language — the server resolves that from the extension, because
 * a client that could name its own language could pair arbitrary code with an
 * arbitrary container image.
 */
export const runRequestSchema = z.object({
  entrypoint: z.string().min(1).max(512),
});

export type RunRequest = z.infer<typeof runRequestSchema>;
