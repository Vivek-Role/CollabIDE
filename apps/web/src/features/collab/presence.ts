import type { AwarenessUser } from '@collab/shared';

import type { User } from '../../lib/types';

/**
 * What this user looks like to everyone else.
 *
 * The colour is derived from the user id rather than stored, so the same person
 * is the same colour in every browser with nothing to keep in sync — and a new
 * account needs no setup to have a cursor you can tell apart.
 */

const PALETTE = [
  '#f97316', // orange
  '#22c55e', // green
  '#3b82f6', // blue
  '#a855f7', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#eab308', // yellow
  '#ef4444', // red
];

export function presenceFor(user: User): AwarenessUser {
  let hash = 0;
  for (const character of user.id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return {
    name: user.displayName,
    color: PALETTE[hash % PALETTE.length] ?? '#3b82f6',
  };
}
