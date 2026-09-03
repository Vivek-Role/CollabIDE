import { useState } from 'react';

import {
  Badge,
  Button,
  ChevronDownIcon,
  ChevronRightIcon,
  EmptyState,
  PlayIcon,
  TrashIcon,
} from '../../components';
import { Terminal, type TerminalHandle } from './Terminal';
import { useRun, type RunSummary } from './useRun';

/**
 * The Run button, the status line and the terminal.
 *
 * All of the feature's weight lives here so ProjectPage stays a layout file.
 *
 * This component reads neither `ready` nor `status` from the collaboration
 * provider, and that is deliberate: those answer questions about the DOCUMENT
 * and its socket, while a run is a server-side operation over REST and SSE.
 * The consequence is worth knowing — a run executes what the SERVER has, so
 * edits made while the socket is down are not included even though they are
 * visible in the editor.
 *
 * Module 10.5 added the collapse, the chips and the icon button. It changed no
 * run behaviour: useRun.ts is untouched, there is no retry, and a finished
 * stream is never reopened.
 */

interface Props {
  projectId: string;
  /** The currently-open file's path. Null when no tab is open. */
  entrypoint: string | null;
  /** Cosmetic only — the server returns 403 for a VIEWER regardless. */
  canEdit: boolean;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The run result, as UI.
 *
 * `useRun` has always returned this summary and RunPanel simply never read it —
 * the exit code and duration existed only as a grey line inside the xterm
 * buffer. `summaryLine()` still writes that line; these chips are an addition,
 * not a replacement, and they render `summary` rather than recomputing it.
 */
function ResultChips({ summary }: { summary: RunSummary }) {
  return (
    <span className="flex items-center gap-1.5">
      {summary.status === 'timeout' ? (
        <Badge tone="warn">timeout · {formatDuration(summary.durationMs)}</Badge>
      ) : summary.status === 'error' ? (
        <Badge tone="danger">failed to start</Badge>
      ) : (
        <Badge tone={summary.exitCode === 0 ? 'success' : 'danger'}>
          exit {summary.exitCode ?? '?'} · {formatDuration(summary.durationMs)}
        </Badge>
      )}

      {summary.truncated ? <Badge tone="warn">output truncated</Badge> : null}
    </span>
  );
}

export function RunPanel({ projectId, entrypoint, canEdit }: Props) {
  const [terminal, setTerminal] = useState<TerminalHandle | null>(null);

  /**
   * Collapsed by default on a small screen (module 10.6), where 176px of
   * terminal is a large share of the editor. Read once at mount — deliberately
   * no resize listener: this is an initial preference, not a live binding, and
   * a listener that re-collapsed the panel while someone was reading output
   * would be worse than the fixed default.
   */
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  const { state, summary, start } = useRun(projectId, terminal);

  const busy = state === 'starting' || state === 'running';
  const name = entrypoint?.slice(entrypoint.lastIndexOf('/') + 1) ?? null;

  return (
    <section
      className={`flex shrink-0 flex-col border-t border-line bg-panel ${collapsed ? 'h-9' : 'h-44 lg:h-56'}`}
    >
      <div
        className={`flex h-9 shrink-0 items-center gap-2 px-2 ${collapsed ? '' : 'border-b border-line'}`}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCollapsed((previous) => !previous)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand output' : 'Collapse output'}
          title={collapsed ? 'Expand output' : 'Collapse output'}
          className="h-6 px-1"
        >
          {collapsed ? (
            <ChevronRightIcon className="h-3.5 w-3.5" />
          ) : (
            <ChevronDownIcon className="h-3.5 w-3.5" />
          )}
        </Button>

        {/* Primary, like every other primary button in the app. Before 10.5 this
            was the one accent button using text-black while the other nine used
            text-surface — the last of the nine hand-rolled button recipes. */}
        <Button
          variant="primary"
          size="sm"
          disabled={!canEdit || !entrypoint}
          loading={busy}
          onClick={() => entrypoint && void start(entrypoint)}
        >
          {busy ? null : <PlayIcon className="h-3 w-3" />}
          {name ? `Run ${name}` : 'Run'}
        </Button>

        {busy ? (
          <span className="flex items-center gap-1.5">
            <Badge tone="warn" dot />
            <span className="text-[11px] text-muted">Running…</span>
          </span>
        ) : summary ? (
          <ResultChips summary={summary} />
        ) : state === 'finished' ? (
          /* A run that never reached the queue — an unsupported file type, a
             payload that was too large, too many runs in flight — resolves with
             NO summary, because useRun only builds one from an exit frame. The
             reason is already in the terminal; without this the header would
             fall back to "Output appears here" and look like nothing happened. */
          <span className="text-[11px] text-muted">Could not start — see output</span>
        ) : (
          <span className="text-[11px] text-muted">
            {entrypoint ? 'Output appears here' : 'Open a file to run it'}
          </span>
        )}

        {/* Clears the xterm buffer and nothing else: no run is cancelled, no
            stream is touched, and useRun is not involved. Hidden until there
            is something to clear. */}
        {state !== 'idle' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => terminal?.clear()}
            aria-label="Clear output"
            title="Clear output"
            className="ml-auto h-6 px-1"
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>

      {/**
       * The terminal stays MOUNTED when collapsed — the container is what
       * collapses. Unmounting it would throw away the scrollback and, worse,
       * invalidate the TerminalHandle this component holds in state: `onReady`
       * fires once per mount, so a remount would leave `useRun` writing into a
       * disposed terminal.
       *
       * Collapsing to zero height makes FitAddon.fit() throw, which Terminal
       * already swallows; on expand its own ResizeObserver fires and re-fits.
       * No change to Terminal.tsx was needed for any of this.
       */}
      <div
        className={`relative min-h-0 ${collapsed ? 'h-0 overflow-hidden' : 'flex-1'} p-1`}
        aria-hidden={collapsed}
      >
        <Terminal onReady={setTerminal} />

        {/* Overlaid rather than swapped in, because swapping would unmount the
            terminal. Gone as soon as anything has run. */}
        {state === 'idle' ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <EmptyState
              size="sm"
              bordered={false}
              title={entrypoint ? 'No output yet' : 'No file open'}
              hint={
                entrypoint
                  ? `Run ${name} to see its output here.`
                  : 'Open a file from the tree to run it.'
              }
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
