import { toFormErrors } from '../../lib/formErrors';
import type { ErrorMapping, FormErrors } from '../../lib/formErrors';

/**
 * The project-specific half of error rendering; the generic half lives in
 * lib/formErrors.ts.
 *
 * LAST_OWNER and CANNOT_REMOVE_SELF are both 409s and Phase 1 split them into
 * two codes on purpose (summary1.md, deviation 8) — they tell the user
 * different things and must not collapse into one message here.
 */
const PROJECT_ERRORS: ErrorMapping = {
  fieldMessages: {
    // The invite dialog's only input is the email, so these belong under it.
    USER_NOT_FOUND: ['email', 'No account exists for that email.'],
    ALREADY_MEMBER: ['email', 'That person is already a member of this project.'],
  },
  messages: {
    LAST_OWNER: 'A project must always have at least one owner.',
    CANNOT_REMOVE_SELF: 'You cannot remove yourself from a project.',
    MEMBER_NOT_FOUND: 'That person is no longer a member of this project.',
  },
  /**
   * FORBIDDEN and PROJECT_NOT_FOUND are deliberately unmapped. The server's own
   * wording is more specific than anything worth writing here ("This action
   * requires the OWNER role"), and leaving them to fall through means one place
   * owns those sentences instead of two that can drift apart.
   */
};

export function toProjectFormErrors(error: unknown): FormErrors {
  return toFormErrors(error, PROJECT_ERRORS);
}

/** For places with no form to attach a field error to — a list header, a card. */
export function toProjectMessage(error: unknown): string {
  const { message, fields } = toProjectFormErrors(error);
  return message || Object.values(fields)[0] || 'Something went wrong.';
}

export type { FormErrors };
