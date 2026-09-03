import { Fragment } from 'react';

import type { Range } from './match';

/**
 * Draws a string with its matched slices marked.
 *
 * A `<mark>` rather than a styled `<span>`: it is what the element is for, and
 * assistive tech announces it. The default yellow-on-black is overridden
 * because it belongs to a browser default palette, not this one.
 *
 * Ranges arrive sorted and non-overlapping from `match.ts`; anything else is
 * skipped rather than trusted, so a bad range can never drop characters from
 * the text or render them twice.
 */
export function Highlight({ text, ranges }: { text: string; ranges: Range[] }) {
  if (ranges.length === 0) return <>{text}</>;

  const parts: Array<{ text: string; marked: boolean }> = [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.start < cursor || range.end > text.length) continue;

    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), marked: false });
    parts.push({ text: text.slice(range.start, range.end), marked: true });
    cursor = range.end;
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor), marked: false });

  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part.marked ? (
            <mark className="rounded-[2px] bg-accent/25 px-px text-ink">{part.text}</mark>
          ) : (
            part.text
          )}
        </Fragment>
      ))}
    </>
  );
}
