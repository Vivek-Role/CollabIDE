import { useEffect, useState } from 'react';

import { Button, CheckIcon, CopyIcon } from '../../components';

/**
 * Copies the open file's path.
 *
 * A feature component, not a seventh primitive: exactly one screen needs it,
 * and the interesting part — the two-second confirmation and the failure path —
 * is behaviour rather than styling.
 *
 * `navigator.clipboard` is unavailable in an insecure context (this app over
 * plain HTTP on a LAN address, for instance), and rejects if the document is
 * not focused. Both are reported in the label rather than swallowed, because a
 * button that silently does nothing is worse than one that says it failed.
 */
export function CopyPathButton({ path }: { path: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;

    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void copy()}
      aria-label={`Copy path ${path}`}
      title="Copy path"
      className="h-5 px-1"
    >
      {state === 'copied' ? (
        <CheckIcon className="h-3 w-3 text-success" />
      ) : (
        <CopyIcon className="h-3 w-3" />
      )}
      {/* Announced, and visible only while it has something to say. */}
      <span role="status" className="text-[11px]">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </Button>
  );
}
