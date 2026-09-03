import { prisma } from '../../db.js';

/**
 * The only writer of `File.content` in the codebase.
 *
 * The field is **derived state**: the update log is the truth, and this is a
 * plain-text projection of it so the runner (Phase 6) and the file listings
 * never have to load a CRDT. It is written on the flush tick, after the append
 * that produced it has succeeded — so derived text may lag the log by one flush
 * interval, and can never lead it.
 *
 * updateMany rather than update: a file deleted while it was open affects zero
 * rows instead of throwing P2025, which is the same reason module 3.4b needed no
 * separate "evict without writing" path.
 */
export async function materializeContent(fileId: string, text: string): Promise<void> {
  await prisma.file.updateMany({
    where: { id: fileId, isDir: false },
    data: { content: text },
  });
}
