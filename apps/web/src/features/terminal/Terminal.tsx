import { FitAddon } from '@xterm/addon-fit';
import { Terminal as Xterm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

/**
 * The run output terminal — display only.
 *
 * There is no input path and there is not meant to be one: the runner never
 * attaches stdin, so a program calling input() reads EOF. Interactive programs
 * are out of scope for Phase 6, and `disableStdin` is where that decision
 * becomes visible rather than implied.
 *
 * Uncontrolled, like the editor: React never holds the output. Frames arrive
 * from the SSE stream and are written straight through, so a long run does not
 * re-render the page once per line.
 */

export interface TerminalHandle {
  write: (text: string, stream?: 'stdout' | 'stderr') => void;
  writeLine: (text: string) => void;
  clear: () => void;
}

/** Built rather than typed: a literal ESC byte in source is invisible and
 *  easily mangled by tooling. */
const ESC = String.fromCharCode(27);
const RED = `${ESC}[31m`;
const GREY = `${ESC}[90m`;
const RESET = `${ESC}[0m`;

interface Props {
  /** Called once with the write handle, when the terminal exists. */
  onReady: (handle: TerminalHandle) => void;
}

export function Terminal({ onReady }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /**
     * xterm needs literal colour values — it paints to a canvas and cannot
     * resolve a CSS var() — so the tokens are read once, here. Before module
     * 10.5 these two were hardcoded hex, which made this the ONE place the
     * palette could silently drift: theme.ts already feeds CodeMirror from the
     * same custom properties. The fallbacks are the previous literals, for the
     * case where the stylesheet has not applied yet.
     */
    const tokens = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string): string =>
      tokens.getPropertyValue(name).trim() || fallback;

    const term = new Xterm({
      convertEol: false,
      disableStdin: true,
      cursorBlink: false,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: {
        background: token('--color-surface', '#0d1117'),
        foreground: token('--color-ink', '#c9d1d9'),
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    // Keep the terminal filling its panel instead of staying 80x24.
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // fit() throws if the element is hidden or zero-sized; nothing to do.
      }
    });
    observer.observe(container);

    termRef.current = term;

    onReady({
      write: (text, stream) => {
        // xterm wants \r\n. Python and Node emit plain \n, and writing that raw
        // gives the staircase effect where each line starts where the last
        // ended. This one replace is what makes output look like output.
        const normalized = text.replace(/\n/g, '\r\n');
        // stderr in red — a terminal already understands this, so no second
        // widget is needed to tell the two streams apart.
        termRef.current?.write(
          stream === 'stderr' ? `${RED}${normalized}${RESET}` : normalized,
        );
      },
      writeLine: (text) => termRef.current?.write(`${GREY}${text}${RESET}\r\n`),
      clear: () => termRef.current?.clear(),
    });

    return () => {
      // React 19 StrictMode double-mounts in dev, so this has to be real or two
      // terminals stack up — the same lesson CollabProvider.destroy() learned.
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
    // onReady is called once per mount; the parent stores the handle in state.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  return <div ref={containerRef} className="h-full w-full" />;
}
