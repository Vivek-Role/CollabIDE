import { useState } from 'react';

import { Alert, Badge, Button, EmptyState, PlusIcon, UsersIcon } from '../../components';
import type { Member, Role } from '../../lib/types';
import { toProjectMessage } from './errors';
import { InviteDialog } from './InviteDialog';

const ROLES: Role[] = ['VIEWER', 'EDITOR', 'OWNER'];

/** Matches ProjectCard, so a role reads the same everywhere. */
const ROLE_TONE: Record<Role, 'accent' | 'neutral'> = {
  OWNER: 'accent',
  EDITOR: 'neutral',
  VIEWER: 'neutral',
};

/** Same reasoning as InviteDialog: native select, no Select primitive. */
const SELECT_CLASS =
  'rounded border border-line bg-surface px-2 py-1 text-xs text-ink outline-none ' +
  'transition-colors duration-100 hover:border-line-strong ' +
  'focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Who is on this project.
 *
 * The list renders for every role — knowing who else can see your code is
 * useful to everyone. Only an OWNER gets the controls, because only an OWNER
 * can use them: showing a role dropdown to an EDITOR would be offering an
 * action the server will refuse with a 403.
 *
 * Module 10.2 removed this component's outer frame AND its own "Members"
 * heading. It is rendered inside Dialog, which already draws the border, the
 * panel background and a header carrying that exact title — so the old markup
 * produced a visible box-in-box with the word "Members" twice.
 */
export function MembersPanel({
  members,
  role,
  onInvite,
  onChangeRole,
  onRemove,
}: {
  members: Member[];
  role: Role | null;
  onInvite: (email: string, role: Role) => Promise<void>;
  onChangeRole: (userId: string, role: Role) => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
}) {
  const [inviting, setInviting] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isOwner = role === 'OWNER';

  async function run(userId: string, action: () => Promise<void>) {
    setBusyUserId(userId);
    setError(null);

    try {
      await action();
    } catch (caught) {
      // LAST_OWNER and CANNOT_REMOVE_SELF are both 409s with different
      // meanings, and they arrive here with their own distinct messages.
      setError(toProjectMessage(caught));
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div className="space-y-3">
      {isOwner ? (
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setInviting(true)}>
            <PlusIcon className="h-3.5 w-3.5" />
            Add member
          </Button>
        </div>
      ) : null}

      {error ? <Alert>{error}</Alert> : null}

      {/* One member means the owner is alone here. Saying so, and pointing at
          the button that fixes it, beats a list of one that looks like a bug. */}
      {members.length <= 1 ? (
        <EmptyState
          size="sm"
          icon={<UsersIcon className="h-5 w-5" />}
          title="You are the only member"
          hint={isOwner ? 'Use Add member to invite someone by email.' : undefined}
        />
      ) : null}

      <ul className="divide-y divide-line">
        {/* Server order (createdAt asc) is kept — the project's first owner
            stays at the top, which is the order people expect. */}
        {members.map((member) => (
          <li key={member.userId} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm text-ink">{member.displayName}</p>
              <p className="truncate text-[11px] text-muted">{member.email}</p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {isOwner ? (
                <select
                  aria-label={`Role for ${member.displayName}`}
                  value={member.role}
                  disabled={busyUserId === member.userId}
                  onChange={(event) =>
                    void run(member.userId, () =>
                      onChangeRole(member.userId, event.target.value as Role),
                    )
                  }
                  className={SELECT_CLASS}
                >
                  {ROLES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <Badge tone={ROLE_TONE[member.role]}>{member.role}</Badge>
              )}

              {isOwner ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyUserId === member.userId}
                  onClick={() => void run(member.userId, () => onRemove(member.userId))}
                  className="hover:text-danger"
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {inviting ? (
        <InviteDialog onInvite={onInvite} onClose={() => setInviting(false)} />
      ) : null}
    </div>
  );
}
