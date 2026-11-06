/*
 * How the admin screens read the API's answers. No imports, so the rules can be tested alone, and
 * no provider's name: these words reach components that the name rule covers.
 */

type Result<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      code: string;
      reason?: string;
      message?: string;
    };

export type Refused = {
  kind: 'refused';
  status: number;
  code: string;
  reason?: string;
  message?: string;
};
export type OpsAnswer<T> =
  | { kind: 'done'; data: T; actedAlone: boolean }
  | { kind: 'waiting'; requestId: string; repeat: boolean }
  | Refused;

/**
 * Done, waiting for a second person, or refused. Waiting is known by the request, not by the 202:
 * email recovery answers 202 when it has run.
 */
export function answerOf<T>(result: Result<T>): OpsAnswer<T> {
  if (!result.ok) {
    const { status, code, reason, message } = result;
    return {
      kind: 'refused',
      status,
      code,
      ...(reason === undefined ? {} : { reason }),
      ...(message === undefined ? {} : { message }),
    };
  }
  const data = (result.data ?? {}) as {
    requestId?: unknown;
    repeat?: unknown;
    actedAlone?: unknown;
  };
  if (result.status === 202 && typeof data.requestId === 'string')
    return {
      kind: 'waiting',
      requestId: data.requestId,
      repeat: data.repeat === true,
    };
  return {
    kind: 'done',
    data: result.data,
    actedAlone: data.actedAlone === true,
  };
}

/** Sends; if the server wants a fresh code, asks for one and sends once more. Refused work did nothing. */
export async function withFreshCode<R extends { ok: boolean; code?: string }>(
  send: () => Promise<R>,
  ask: () => Promise<boolean>,
): Promise<R> {
  const first = await send();
  if (first.ok || first.code !== 'FRESH_CODE_REQUIRED') return first;
  return (await ask()) ? send() : first;
}

export const STALE_WORDS: Record<string, string> = {
  requester_lost_access:
    'It did not run: the person who asked no longer holds the permission.',
  requester_removed: 'It did not run: the person who asked has left staff.',
  requester_reset:
    'It did not run: the person who asked had their authenticator reset.',
  facts_changed:
    'It did not run: the facts changed after it was asked. Look again, and ask again if it’s still needed.',
  description_changed:
    'It did not run: what it would do has changed from what was written here. Ask again if it’s still needed.',
  permission_changed:
    'It did not run: the access it depends on changed after it was asked.',
  action_unknown: 'It did not run: this action no longer exists.',
  superseded:
    'It did not run: the person who asked did this themselves, with nobody left to approve it.',
};

export const APPROVAL_STATUS_WORDS: Record<string, string> = {
  pending: 'Waiting',
  approved: 'Approved and done',
  rejected: 'Rejected',
  cancelled: 'Cancelled by the person who asked',
  expired: 'Expired: nobody decided in 24 hours',
  stale: 'Stopped without running',
};

export const STAFF_ACTIVITY_WORDS: Record<string, string> = {
  'staff.added': 'Added someone to staff',
  'staff.removed': 'Removed someone from staff',
  'staff.role_changed': 'Changed someone’s role',
  'staff.access_changed': 'Changed someone’s access',
  'staff.authenticator_reset': 'Reset someone’s authenticator',
  'staff.invitation_declined': 'Turned down an invitation to staff',
  'role.created': 'Created a role',
  'role.updated': 'Edited a role',
  'role.deleted': 'Deleted a role',
  'serious_action.ran': 'A serious action ran, after a second person approved',
  'serious_action.ran_alone': 'Acted alone, with nobody else to approve',
  'serious_action.rejected': 'Rejected a serious action',
  'serious_action.stale': 'A serious action stopped without running',
  'withdrawals.released': 'Withdrawals resumed for a recipient',
  'withdrawals.freeze_lifted': 'Closed a reported takeover',
  'withdrawals.freeze_reopened':
    'A takeover was reported again: a new issue now holds the freeze',
  'username.take_back_started': 'Started taking a username back from a page',
  'username.take_back_done': 'A username take-back finished',
  'username.released': 'Released a reserved username',
};

const REFUSALS: Record<string, string> = {
  FRESH_CODE_REQUIRED:
    'This needs a fresh authenticator code. Nothing changed.',
  FORBIDDEN: 'Your role doesn’t allow this. Nothing changed.',
  PERMISSION_NOT_HELD: 'You don’t hold what this needs. Nothing changed.',
  RATE_LIMITED:
    'You’ve asked for a lot of these this hour. Nothing changed; try again later.',
  ISSUE_RESOLVED: 'This issue was already resolved. Nothing changed.',
  PAYOUT_CHANGED:
    'The withdrawal changed while you were deciding. Nothing was done; ask the provider again.',
  STAFF_ADMIN_BUSY:
    'Another staff change is going through. Nothing changed; try again in a moment.',
  APPROVAL_ALREADY_PENDING:
    'Your earlier request for this is still waiting. Cancel it in Approvals to do this yourself.',
  APPROVAL_SUBJECT:
    'That address is a staff mailbox, or this concerns you. Nothing changed.',
  USERNAME_BUILT_IN: 'TipMe’s own list already reserves this',
  USERNAME_RESERVED: 'This username is already reserved',
  USERNAME_HELD_BY_PAGE:
    'A page has this username, now or as an old one. To take it, ask to take it back.',
  USERNAME_NOT_RESERVED: 'This username isn’t reserved',
  TAKE_BACK_OPEN: 'This username already has a take-back under way',
  TAKE_BACK_CLOSED: 'This take-back has already finished',
  TAKE_BACK_NOT_FOUND: 'We couldn’t find that take-back',
};

const UNKNOWN =
  'We can’t say whether it went through. Reload and check before trying again.';
const NO_ANSWER = `We got no answer. ${UNKNOWN}`;

/** The answer doesn't say what happened: it may have committed with the reply lost. */
export function outcomeIsUnknown(answer: {
  status: number;
  code: string;
}): boolean {
  return (
    answer.status === 0 ||
    (answer.status >= 500 && answer.code !== 'STAFF_ADMIN_BUSY')
  );
}

/**
 * What to tell staff. "Nothing changed" only where the server's refusal means that: a 5xx or an
 * answer we don't know could mean it happened.
 */
export function refusalWords(
  answer: {
    status: number;
    code: string;
    message?: string;
  },
  /** The page that holds the name, when the screen knows it (USERNAME_HELD_BY_PAGE). */
  context?: { handle?: string },
): string {
  if (answer.status === 0) return NO_ANSWER;
  if (outcomeIsUnknown(answer)) return UNKNOWN;
  if (answer.code === 'USERNAME_HELD_BY_PAGE' && context?.handle)
    return `This is @${context.handle}’s username. To take it, ask to take it back.`;
  return (
    REFUSALS[answer.code] ??
    answer.message ??
    `That was refused, and we don’t have words for why. ${UNKNOWN}`
  );
}

/** Refusing an approval: whether the request is still there to decide, and why it wasn't done. */
export function approveRefusal(answer: {
  status: number;
  code: string;
  reason?: string;
  message?: string;
}): { stillWaiting: boolean; unknown?: boolean; text: string } {
  switch (answer.code) {
    case 'DEPENDENCY_UNAVAILABLE':
    case 'STAFF_ADMIN_BUSY':
      return {
        stillWaiting: true,
        text: 'The provider or the system can’t answer just now, so nothing ran. It’s still waiting; try again in a minute.',
      };
    case 'CODE_INVALID':
      return {
        stillWaiting: true,
        text: 'That code didn’t work. Wait for the next one in your app and try again.',
      };
    case 'CODE_ALREADY_USED':
      return {
        stillWaiting: true,
        text: 'That code has just been used. Wait for the next one in your app.',
      };
    case 'OPS_LOCKED':
    case 'RATE_LIMITED':
      return {
        stillWaiting: true,
        text: 'Too many tries. Nothing ran and it’s still waiting; try again in a few minutes.',
      };
    case 'APPROVAL_OWN_REQUEST':
      return {
        stillWaiting: true,
        text: 'This came from you, or from an account sharing your mailbox, so someone else must decide it.',
      };
    case 'APPROVAL_SUBJECT':
      return {
        stillWaiting: true,
        text: 'This concerns you or your own mailbox, so someone else must decide it.',
      };
    case 'PERMISSION_NOT_HELD':
    case 'FORBIDDEN':
      return {
        stillWaiting: true,
        text: 'You don’t hold what this needs, so someone else must decide it.',
      };
    case 'APPROVAL_STALE':
      return {
        stillWaiting: false,
        text:
          (answer.reason && STALE_WORDS[answer.reason]) ??
          'It did not run: something changed after it was asked.',
      };
    case 'APPROVAL_EXPIRED':
      return {
        stillWaiting: false,
        text: 'This request has expired. Nothing ran; it needs asking again.',
      };
    case 'APPROVAL_CLOSED':
      return {
        stillWaiting: false,
        text: 'Someone has already decided this. See the history below.',
      };
    default:
      return outcomeIsUnknown(answer)
        ? {
            stillWaiting: false,
            unknown: true,
            text: 'We can’t say whether it ran. The list below has been read again: check it before trying again.',
          }
        : { stillWaiting: true, text: refusalWords(answer) };
  }
}

/** A person's ticks as what differs from their role: the only thing stored for them. */
export function accessAdjustments(
  rolePermissions: readonly string[],
  ticked: readonly string[],
): { additions: string[]; removals: string[] } {
  return {
    additions: ticked.filter((p) => !rolePermissions.includes(p)),
    removals: rolePermissions.filter((p) => !ticked.includes(p)),
  };
}
