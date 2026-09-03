import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useRouteError } from 'react-router';

import { AlertIcon, Button } from '../components';

/**
 * The last line of defence: without one of these, a thrown render error unmounts
 * the whole tree and leaves a white page with the reason only in the console.
 *
 * Two entry points, because React and the router catch different things:
 *
 *   ErrorBoundary   a class component — the only way to catch a render error,
 *                   since hooks cannot. Wraps the router itself.
 *   RouteErrorPage  the router's errorElement, for anything it catches inside a
 *                   route (a loader, an action, a lazy chunk that fails to load).
 *
 * Both render the same panel, so a user sees one thing however it broke.
 *
 * This is deliberately NOT a general error-handling framework. Expected failures
 * — a 404, a validation error, a lost connection — are already handled where
 * they happen, by ApiError codes, the feature error maps and the collaboration
 * status line. This is for the unexpected ones.
 *
 * Module 10.6 replaced this file's hand-rolled `bg-white/10` buttons — the only
 * place in the client that ignored the token system — with the shared Button.
 */

function ErrorPanel({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const detail =
    error instanceof Error ? error.message : typeof error === 'string' ? error : null;

  return (
    <div role="alert" className="flex h-full items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md text-center">
        <span className="mb-3 inline-flex text-danger">
          <AlertIcon className="h-6 w-6" />
        </span>

        <p className="text-sm font-medium text-ink">Something went wrong</p>
        <p className="mt-2 text-xs text-muted">
          This part of the app failed to render. Your work is stored on the server and in this
          browser — reloading does not lose it.
        </p>

        {detail !== null && (
          <pre className="mt-3 max-h-40 overflow-auto rounded border border-line bg-surface p-2 text-left text-[11px] text-muted">
            {detail}
          </pre>
        )}

        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {onRetry && (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
          {/* An anchor, not a router Link: this renders when the router itself
              may be the thing that failed, so a full document load is the point. */}
          <a
            href="/projects"
            className="inline-flex h-7 shrink-0 items-center justify-center rounded border border-line px-2.5 text-xs font-medium text-ink outline-none transition-colors duration-100 hover:border-line-strong hover:bg-elevated focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Back to projects
          </a>
        </div>
      </div>
    </div>
  );
}

/** The router's errorElement. useRouteError is the only way to read what it
 *  caught, and it is a hook — hence a separate component from the class below. */
export function RouteErrorPage() {
  return <ErrorPanel error={useRouteError()} />;
}

interface Props {
  children: ReactNode;
}

interface State {
  error: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No error reporting service in this project, so the console is the record.
    // The component stack is the useful half and React does not print it here.
    console.error('Unhandled render error:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <ErrorPanel error={this.state.error} onRetry={() => this.setState({ error: null })} />
      );
    }
    return this.props.children;
  }
}
