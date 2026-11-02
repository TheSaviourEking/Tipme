import { ZodError } from 'zod';
import type { MailContext, MailType, RenderedMail } from './define.js';
import {
  emailChangedNotice,
  newSignInNotice,
  recoveryCancelledNotice,
  recoveryCompletedNotice,
  recoveryStartedNotice,
  welcome,
} from './types/account-notices.js';
import {
  emailChangeCode,
  payoutDestinationCode,
  recoveryChangeCode,
  recoveryCode,
  recoveryEmailCode,
  recoveryNewEmailCode,
  signInCode,
} from './types/sign-in-code.js';
import {
  accountDeletedNotice,
  milestone,
  pagePaused,
  pageImageRemoved,
  pageRestored,
  paymentAccountActionNeeded,
  paymentAccountReady,
  staffAccessNotice,
  tipReversed,
  withdrawalFailed,
  withdrawalPaid,
} from './types/account-events.js';
import { emailVerificationLink } from './types/email-verification-link.js';
import { payoutDestinationChanged } from './types/payout-destination-changed.js';
import { phoneChangeWarning } from './types/phone-change-warning.js';
import { providerTest } from './types/provider-test.js';
import { recoveryLink } from './types/recovery-link.js';
import {
  staffActedAlone,
  staffFreezeReleased,
  staffApprovalOutcome,
  staffApprovalPending,
  staffLastApproverRemoved,
  staffInvitation,
  staffInvitationDeclined,
} from './types/staff-invitation.js';
import { tipReceived } from './types/tip-received.js';
import { weeklyReport } from './types/weekly-report.js';

// Heterogeneous registry: each entry checks its own data with its schema before rendering.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MAIL_TYPES: Record<string, MailType<any>> = Object.fromEntries(
  [
    tipReceived,
    weeklyReport,
    emailVerificationLink,
    recoveryLink,
    staffInvitation,
    staffInvitationDeclined,
    staffActedAlone,
    staffFreezeReleased,
    staffApprovalOutcome,
    staffApprovalPending,
    staffLastApproverRemoved,
    phoneChangeWarning,
    providerTest,
    signInCode,
    emailChangeCode,
    payoutDestinationCode,
    payoutDestinationChanged,
    welcome,
    newSignInNotice,
    emailChangedNotice,
    recoveryEmailCode,
    recoveryChangeCode,
    recoveryCode,
    recoveryNewEmailCode,
    recoveryStartedNotice,
    recoveryCancelledNotice,
    recoveryCompletedNotice,
    staffAccessNotice,
    accountDeletedNotice,
    paymentAccountReady,
    paymentAccountActionNeeded,
    pagePaused,
    pageImageRemoved,
    pageRestored,
    withdrawalPaid,
    withdrawalFailed,
    tipReversed,
    milestone,
  ].map((type) => [type.id, type]),
);

/** Validates, renders, and makes the stored snapshot (none for security mail). */
export function renderMail(
  typeId: string,
  data: unknown,
  ctx: MailContext,
): RenderedMail & { snapshot: RenderedMail | null } {
  const type = MAIL_TYPES[typeId];
  if (!type)
    throw new ZodError([
      {
        code: 'custom',
        message: `Unknown mail type ${typeId}`,
        path: ['type'],
        input: typeId,
      },
    ]);
  const parsed: unknown = type.schema.parse(data);
  const rendered = type.render(parsed, { ...ctx, redact: false });
  const snapshot =
    type.category === 'security'
      ? null
      : type.render(parsed, { ...ctx, redact: true });
  return { ...rendered, snapshot };
}
