import type { RunFrame } from '@collab/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, api } from '../../lib/api';
import type { TerminalHandle } from './Terminal';

/**
 * Starting a run and consuming its output.
 *
 * Two calls, and they take DIFFERENT url forms — this is the easiest mistake in
 * the feature:
 *
 *   api.post('/projects/:id/run')                        <- no /api prefix
 *   new EventSource('/api/projects/:id/runs/:jobId/stream') <- with it
 *
 * api.ts sets BASE = '/api' and prefixes every request itself, so passing the
 * full path there produces /api/api/... and a 404 that looks like a routing bug.
 *
 * EventSource deliberately bypasses api.ts. The "api.ts is the only place that
 * calls fetch" rule is intact — EventSource is not fetch — and it could not go
 * through the wrapper anyway: request<T>() awaits a COMPLETE response and
 * returns parsed JSON, while a stream stays open by design. CollabProvider
 * builds its own WebSocket URL outside api.ts for exactly the same reason.
 */

export type RunState = 'idle' | 'starting' | 'running' | 'finished';

export interface RunSummary {
  status: 'ok' | 'timeout' | 'error';
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

/** Branches on `code`, never on `message` — the client's standing rule. */
function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not start the run.';

  switch (error.code) {
    case 'LANGUAGE_UNSUPPORTED':
      return "There's no runtime for this file type.";
    case 'RUN_TOO_LARGE':
      return error.message;
    case 'TOO_MANY_RUNS':
      return 'Too many runs in progress. Try again in a moment.';
    case 'FILE_NOT_FOUND':
      return 'That file no longer exists.';
    default:
      return 'Could not start the run.';
  }
}

function summaryLine(summary: RunSummary): string {
  const seconds = (summary.durationMs / 1000).toFixed(1);
  const truncated = summary.truncated ? ' (output truncated at 1 MB)' : '';

  if (summary.status === 'timeout') return `— TIMEOUT after ${seconds}s`;
  if (summary.status === 'error') return '— the run could not be started';

  return `— exited ${summary.exitCode ?? '?'} in ${summary.durationMs}ms${truncated}`;
}

export function useRun(projectId: string, terminal: TerminalHandle | null) {
  const [state, setState] = useState<RunState>('idle');
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const closeStream = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  // A stream must never outlive the component or the project.
  useEffect(() => closeStream, [closeStream, projectId]);

  const start = useCallback(
    async (entrypoint: string) => {
      if (state === 'starting' || state === 'running') return;

      closeStream();
      terminal?.clear();
      setSummary(null);
      setState('starting');

      let jobId: string;
      try {
        const started = await api.post<{ jobId: string }>(`/projects/${projectId}/run`, {
          entrypoint,
        });
        jobId = started.jobId;
      } catch (error) {
        // A failed run is output: the terminal is where the user is looking.
        terminal?.writeLine(messageFor(error));
        setState('finished');
        return;
      }

      setState('running');

      const source = new EventSource(`/api/projects/${projectId}/runs/${jobId}/stream`);
      sourceRef.current = source;

      const finish = (result: RunSummary): void => {
        terminal?.writeLine(summaryLine(result));
        setSummary(result);
        setState('finished');
        // THE important line. EventSource reconnects on any disconnect,
        // including a clean end — without this, every finished run reopens its
        // stream, 404s against a deleted registry entry, and loops. Phase 5
        // owns reconnection; this feature deliberately has none.
        closeStream();
      };

      source.onmessage = (event) => {
        const frame = JSON.parse(event.data as string) as RunFrame;

        if (frame.type === 'exit') {
          finish({
            status: frame.status,
            exitCode: frame.exitCode,
            durationMs: frame.durationMs,
            truncated: frame.truncated,
          });
          return;
        }

        terminal?.write(frame.data, frame.type);
      };

      source.onerror = () => {
        // Same discipline on the failure path: close, report, stop.
        if (sourceRef.current) {
          terminal?.writeLine('— the output stream was interrupted');
          setState('finished');
          closeStream();
        }
      };
    },
    [closeStream, projectId, state, terminal],
  );

  return { state, summary, start };
}
