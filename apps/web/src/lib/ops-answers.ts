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

export const SERIOUS_ACTION_WORDS: Record<string, string> = {
  'email_recovery.start': 'Move an account to a new email address',
  'payout.settle': 'Settle a stuck withdrawal',
  'money_issue.close': 'Close a money issue',
  'fee.change': 'Change a page’s fee',
  'fee.free': 'Give a page fee-free tips',
  'staff.grant_owner': 'Make someone an owner',
  'staff.grant_sensitive': 'Give someone sensitive access',
  'role.add_sensitive': 'Add sensitive access to a role',
  'staff.reset_authenticator': 'Reset someone’s authenticator',
  'mail_provider.switch': 'Switch the active email provider',
};

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
  DEPENDENCY_UNAVAILABLE:
    'The provider can’t be reached just now. Nothing changed; try again in a minute.',
  STAFF_ADMIN_BUSY:
    'Another staff change is going through. Nothing changed; try again in a moment.',
  APPROVAL_ALREADY_PENDING:
    'Your earlier request for this is still waiting. Cancel it in Approvals to do this yourself.',
  APPROVAL_SUBJECT:
    'That address is a staff mailbox, or this concerns you. Nothing changed.',
  NETWORK:
    'We got no answer, so we can’t say whether it went through. Check the screen before trying again.',
};

/** What to tell staff: our words where the stakes need them, otherwise the server's fixed message. */
export function refusalWords(answer: {
  code: string;
  message?: string;
}): string {
  return (
    REFUSALS[answer.code] ??
    answer.message ??
    'That didn’t work. Nothing changed; please try again.'
  );
}

/** Refusing an approval: whether the request is still there to decide, and why it wasn't done. */
export function approveRefusal(answer: {
  status: number;
  code: string;
  reason?: string;
  message?: string;
}): { stillWaiting: boolean; text: string } {
  switch (answer.code) {
    case 'DEPENDENCY_UNAVAILABLE':
    case 'STAFF_ADMIN_BUSY':
    case 'NETWORK':
      return {
        stillWaiting: true,
        text:
          answer.code === 'NETWORK'
            ? 'We got no answer. It’s probably still waiting; look at the list below, then try again.'
            : 'The provider or the system can’t answer just now, so nothing ran. It’s still waiting; try again in a minute.',
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
      return { stillWaiting: true, text: refusalWords(answer) };
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
