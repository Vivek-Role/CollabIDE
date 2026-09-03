import type { RunFrame } from '@collab/shared';
import type { Request, Response } from 'express';

import * as registry from './registry.js';

/**
 * The run-output stream, as Server-Sent Events.
 *
 * SSE rather than the collaboration WebSocket, deliberately: that socket is per
 * *document* (/ws?doc=projectId:fileId) while a run belongs to a *project*, so
 * it has no principled answer to "which file's connection carries this" or
 * "what if nothing is open". SSE is same-origin through the existing /api proxy
 * so it inherits the session cookie, it is one-way like a display-only
 * terminal, and it ends with the run instead of living as long as the tab.
 *
 * Consequences that are rules: MessageType gains no member, CollabProvider is
 * not touched, reconnect.ts is not imported, and no second reconnect system
 * appears. EventSource's own auto-reconnect is suppressed client-side (6.7) by
 * closing on the terminal frame.
 */
export function streamRun(req: Request, res: Response, jobId: string): void {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    // no-transform also asks intermediaries not to buffer or rewrite.
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // For a future nginx in front of this; free here.
    'X-Accel-Buffering': 'no',
  });

  // Without this Express sends nothing until the first write, and a browser
  // waiting on headers shows an empty terminal.
  res.flushHeaders();

  const send = (frame: RunFrame): void => {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);

    // The terminal frame ends the response. The registry closes its own
    // subscription on the same frame.
    if (frame.type === 'exit') res.end();
  };

  // Frames buffered before this request arrived are replayed first, in order.
  registry.attach(jobId, send);

  // The client going away detaches the sink; the subscription stays open so the
  // run can still reach its terminal frame.
  req.on('close', () => registry.detach(jobId));
}
