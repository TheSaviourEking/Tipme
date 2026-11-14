import {
  OPS_CATALOGUE,
  OPS_ISSUE_OUTCOME_WORDS,
  type OpsIssueOutcome,
  type OpsPermission,
} from '@tipme/contracts';
import type { MailProviderName } from '@tipme/mail';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  businesses,
  businessManagers,
  issues,
  payouts,
  profiles,
  providerSettings,
  roles,
  staff,
  tipBusinessShares,
  tips,
  users,
} from '../schema.js';
import {
  maskEmail,
  normaliseEmail,
  normaliseStaffEmail,
} from './email-address.js';
import {
  businessManagerUsers,
  businessVerifyFacts,
  verifyBusiness,
} from './business-ops.js';
import { startStaffRecovery } from './email-recovery.js';
import { guarded, OperationError } from './errors.js';
import { grantFeeFreeTips, setAccountFee } from './fees.js';
import { addIssueNote, resolveIssue } from './issues.js';
import { openPayoutConflict } from './payout-start.js';
import {
  applyAfterRead,
  markFailedAfterRead,
  payoutCaseFacts,
  readPayoutForAction,
  refuseToApply,
  refuseToMarkFailed,
  withCurrentCase,
  type PreparedPayoutRead,
} from './payout-staff.js';
import { hasConfirmedMailTest, switchMailProvider } from './provider-admin.js';
import { takeBackAction } from './username-take-backs.js';
import { alreadyReversed, reversalsOf, reverseTip } from './reversals.js';
import { changelogPublishAction } from './changelog-admin.js';
import { askProRefund, proRefundFacts } from './pro-refunds.js';
import {
  checkedProPrice,
  currentProPrice,
  nairaOf,
  setProPrice,
} from './pro-price.js';
import {
  qualifiedApprovers,
  registerSeriousAction,
  requestSeriousAction,
  type SeriousActionCheck,
  type SeriousActionDefinition,
  type SeriousActionOutcome,
  type SeriousActionServices,
} from './serious-actions.js';
import {
  addStaff,
  changeRole,
  resetAuthenticator,
  setPersonalAccess,
  updateRole,
} from './staff-admin.js';
import {
  composeAccess,
  lockStaffAdmin,
  mailboxesOf,
  readOverrides,
  readRolePermissions,
  readStaffAccess,
  readMailboxes,
  sharesMailbox,
  whileHoldingStaffAdmin,
} from './staff.js';

/*
 * The real serious actions. Each action's work is one function, `act`, used for the check at asking
 * and for the run. It only waits on the transaction it is given (ruling N1): queued mail is a row in
 * it, and a provider's answer comes from `prepare`, before the transaction. Loaded by the API and the
 * worker, as a pending request's mail depends on who may decide. Nothing runs at import.
 */

const isSensitive = (permission: string): boolean =>
  OPS_CATALOGUE[permission as OpsPermission]?.sensitive === true;

function servicesOf(check: { services?: SeriousActionServices | undefined }) {
  if (!check.services) throw new OperationError('INVALID_INPUT');
  return check.services;
}

class DryRunDone extends Error {}

/**
 * Whether it would go through, by doing it and undoing it: the same checks as the run, so a request
 * that could never pass isn't left waiting on someone.
 */
async function dryRun(
  tx: Tx,
  work: (savepoint: Tx) => Promise<unknown>,
): Promise<void> {
  try {
    await tx.transaction(async (savepoint) => {
      await work(savepoint);
      throw new DryRunDone();
    });
  } catch (error) {
    if (!(error instanceof DryRunDone)) throw error;
  }
}

/** An action whose check is a dry run of its work. */
function acting<Payload>(
  definition: Omit<SeriousActionDefinition<Payload>, 'validate' | 'run'> & {
    act(
      tx: Tx,
      payload: Payload,
      context: SeriousActionCheck & { approverId?: string | null },
    ): Promise<unknown>;
  },
): SeriousActionDefinition<Payload> {
  const { act, ...rest } = definition;
  return {
    ...rest,
    validate: (tx, payload, check) =>
      dryRun(tx, (savepoint) => act(savepoint, payload, check)),
    run: (tx, payload, context) => act(tx, payload, context),
  };
}

const pageOwner = async (db: Database | Tx, profileId: string) => {
  const [page] = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  return page?.userId ? [page.userId] : [];
};

/**
 * Who a withdrawal's money belongs to, as people: the page's owner, or (R2-B) everyone who runs
 * the business, past managers included. None of them may decide their own withdrawal's case.
 */
const payoutOwners = async (
  db: Database | Tx,
  owner: { profileId: string } | { businessId: string },
) => {
  if ('profileId' in owner) return pageOwner(db, owner.profileId);
  const managers = await db
    .select({ userId: businessManagers.userId })
    .from(businessManagers)
    .where(eq(businessManagers.businessId, owner.businessId));
  return managers.map(({ userId }) => userId);
};

/** A business's open owners (Business Pro, ruling R22: a refund's subjects). */
const openBusinessOwners = async (db: Database | Tx, businessId: string) => {
  const owners = await db
    .select({ userId: businessManagers.userId })
    .from(businessManagers)
    .where(
      and(
        eq(businessManagers.businessId, businessId),
        eq(businessManagers.role, 'owner'),
        isNull(businessManagers.removedAt),
      ),
    );
  return owners.map(({ userId }) => userId);
};

const handleOf = async (db: Database | Tx, profileId: string) => {
  const [page] = await db
    .select({ handle: profiles.handle })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  if (!page) throw new OperationError('PROFILE_NOT_FOUND');
  return page.handle;
};

const personHint = async (db: Database | Tx, userId: string) => {
  const [person] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return person?.email ? maskEmail(person.email) : 'a staff member';
};

/** Who an address already belongs to: they are who a grant by address would benefit. */
const accountOfEmail = async (db: Database | Tx, email: string) => {
  const [person] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
  return person ? [person.id] : [];
};

const isOwner = (approver: { access: { roleId: string } }) =>
  approver.access.roleId === 'owner';

const roleStamp = async (db: Database | Tx, roleId: string) => {
  const [role] = await db
    .select({ at: sql<string>`${roles.updatedAt}::text` })
    .from(roles)
    .where(eq(roles.id, roleId));
  if (!role) throw new OperationError('ROLE_NOT_FOUND');
  return role.at;
};

const roleName = async (db: Database | Tx, roleId: string) => {
  const [role] = await db
    .select({ name: roles.name })
    .from(roles)
    .where(eq(roles.id, roleId));
  if (!role) throw new OperationError('ROLE_NOT_FOUND');
  return role.name;
};

/* Email recovery */

const reachesStaffMailbox = async (db: Database | Tx, address: string) => {
  const box = normaliseStaffEmail(address);
  const everyone = await db
    .select({
      email: users.email,
      recoveryEmail: users.recoveryEmail,
      recoveryVerifiedAt: users.recoveryEmailVerifiedAt,
    })
    .from(staff)
    .innerJoin(users, eq(users.id, staff.userId))
    .where(isNull(staff.revokedAt));
  return everyone.some((person) => mailboxesOf(person).has(box));
};

interface RecoveryPayload {
  userId: string;
  newEmail: string;
  checks: string;
}

const emailRecovery = acting<RecoveryPayload>({
  name: 'email_recovery.start',
  permission: 'recoveries.manage',
  subjects: ({ userId }) => [userId],
  mailboxes: ({ newEmail }) => [newEmail],
  afterClose: (payload) => ({
    ...payload,
    newEmail: maskEmail(payload.newEmail),
  }),
  target: ({ userId }) => userId,
  // The address stays masked (the owner's ruling), with whether it matches anyone on staff.
  describe: async (tx, { userId, newEmail, checks }) =>
    `Move ${await personHint(tx, userId)} to the email address ${maskEmail(newEmail)}, which ${
      (await reachesStaffMailbox(tx, newEmail))
        ? 'MATCHES a staff mailbox'
        : 'matches no staff mailbox'
    }. Identity checks: ${checks}`,
  act: async (tx, payload, context) => {
    // Anyone's, not just the people deciding: someone refused as an approver stops counting, and
    // the action would then run alone, to the mailbox of the person who could have stopped it.
    if (await reachesStaffMailbox(tx, payload.newEmail))
      throw new OperationError('APPROVAL_SUBJECT');
    const outcome = await startStaffRecovery(tx, servicesOf(context).sealing, {
      staffUserId: context.actorId,
      userId: payload.userId,
      newEmail: payload.newEmail,
      checks: payload.checks,
      reason: context.reason,
      secret: servicesOf(context).authCodeSecret,
      now: context.now,
    });
    if (outcome === 'not_found') throw new OperationError('APPROVAL_NOT_FOUND');
    if (outcome === 'staff_account')
      throw new OperationError('RECOVERY_STAFF_ACCOUNT');
    if (outcome === 'invalid') throw new OperationError('INVALID_INPUT');
    return { outcome };
  },
});

/* Money */

type SettlePayload =
  | { issueId: string; how: 'apply'; reported: 'paid' | 'failed' }
  | { issueId: string; how: 'mark_failed' };

const settleInput = (
  payload: SettlePayload,
  context: SeriousActionCheck,
  provider: NonNullable<SeriousActionServices['payoutReader']>,
) => ({
  issueId: payload.issueId,
  staffUserId: context.actorId,
  provider,
  reason: context.reason,
  now: context.now,
});

const noReads = () => {
  // The answer was read in `prepare`. Reading from here would wait on a provider inside the lock.
  throw new OperationError('INVALID_INPUT');
};

const payoutSettle = acting<SettlePayload>({
  name: 'payout.settle',
  permission: 'payouts.resolve',
  prepare: async (db, payload, { actorId, services }) => {
    const provider = servicesOf({ services }).payoutReader;
    if (!provider) throw new OperationError('INVALID_INPUT');
    const read = await readPayoutForAction(db, {
      issueId: payload.issueId,
      staffUserId: actorId,
      provider,
      ...(services?.payoutLog ? { log: services.payoutLog } : {}),
    });
    const { answer, kase, now } = read;
    // We don't know yet: not a reason to close anything, so nothing has happened and it can wait.
    if (answer.state === 'uncertain' || answer.state === 'ambiguous')
      throw new OperationError('PROVIDER_STATUS_UNKNOWN');
    // Out here it stays, whatever happens to the request: someone must look at a mismatch.
    if (
      payload.how === 'apply' &&
      answer.state === payload.reported &&
      'found' in answer &&
      answer.differing.length > 0 &&
      ['REQUESTED', 'PROCESSING'].includes(kase.payout.status)
    )
      await openPayoutConflict(db, {
        payoutId: kase.payout.id,
        why: 'mismatch',
        fields: answer.differing,
        now,
      });
    return read;
  },
  subjects: async ({ issueId }, db) => {
    const facts = await payoutCaseFacts(db, issueId);
    return facts ? payoutOwners(db, facts.owner) : [];
  },
  target: ({ issueId }) => issueId,
  current: async (tx, { issueId }) =>
    (await payoutCaseFacts(tx, issueId))?.status ?? null,
  describe: async (tx, payload) => {
    const facts = await payoutCaseFacts(tx, payload.issueId);
    if (!facts) throw new OperationError('ISSUE_NOT_FOUND');
    const end = facts.payoutId.slice(-6);
    return payload.how === 'apply'
      ? `Record withdrawal ending ${end} as ${payload.reported}, as the payment provider reports`
      : `Mark withdrawal ending ${end} failed: the payment provider has no such payout, so its money is released`;
  },
  act: async (tx, payload, context) => {
    const input = settleInput(payload, context, noReads);
    const prepared = await withCurrentCase(
      tx,
      input,
      context.facts as PreparedPayoutRead,
    );
    const refusal =
      payload.how === 'apply'
        ? await refuseToApply(
            tx,
            { ...input, reported: payload.reported },
            prepared,
          )
        : await refuseToMarkFailed(tx, input, prepared);
    // Nothing settled, so nothing may read as approved or as having run alone. The throw undoes
    // this run's writes; the request, if any, closes as stale.
    const settled =
      refusal ??
      (payload.how === 'apply'
        ? await applyAfterRead(
            tx,
            { ...input, reported: payload.reported },
            prepared,
          )
        : await markFailedAfterRead(tx, input, prepared));
    if (settled.outcome !== 'applied' && settled.outcome !== 'marked_failed')
      throw new OperationError('PAYOUT_CHANGED', `payout_${settled.outcome}`);
    return settled;
  },
  // The run's own conflict went with its rollback, and someone must look at this.
  afterRefusal: async (db, _payload, { detail }, check) => {
    if (detail !== 'payout_mismatch') return;
    const { answer, kase, now } = check.facts as PreparedPayoutRead;
    if (!('found' in answer)) return;
    const [current] = await db
      .select({ reference: payouts.providerReference })
      .from(payouts)
      .where(eq(payouts.id, kase.payout.id));
    const two =
      current?.reference &&
      current.reference !== answer.found.providerReference;
    await openPayoutConflict(db, {
      payoutId: kase.payout.id,
      why: two ? 'two_references' : 'mismatch',
      fields: answer.differing,
      now,
    });
  },
});

/**
 * Any hand close of a money issue: closing one can lift a hold, whichever outcome is named. The
 * outcome is in the payload and the words, so the approver agrees to that one.
 */
/**
 * Someone releasing the freeze on their own page. A second person who could do it means they can't;
 * with nobody else it goes the alone way, so the log and alert say so (the owner's ruling).
 */
export async function freezeReleaseBySubject(
  db: Database,
  input: { issueId: string; actorId: string },
): Promise<'not_subject' | 'refused' | 'alone'> {
  return guarded(async () => {
    const [issue] = await db
      .select({ subject: issues.subject })
      .from(issues)
      .where(eq(issues.id, input.issueId));
    const { profileId } = issue?.subject ?? {};
    const owners = profileId ? await pageOwner(db, profileId) : [];
    const mine = await readMailboxes(db, input.actorId);
    let subject = false;
    for (const owner of owners)
      if (
        owner === input.actorId ||
        sharesMailbox(mine, await readMailboxes(db, owner))
      )
        subject = true;
    if (!subject) return 'not_subject';
    const others = await qualifiedApprovers(db, {
      permission: 'payouts.resolve',
      requesterId: input.actorId,
      action: 'money_issue.close',
      payload: { issueId: input.issueId, outcome: 'account_secured' },
    });
    return others.length > 0 ? 'refused' : 'alone';
  });
}

const moneyIssueClose = acting<{
  issueId: string;
  outcome: OpsIssueOutcome | null;
  bankAndSignInChecked?: boolean;
}>({
  name: 'money_issue.close',
  permission: 'payouts.resolve',
  // The route asks for this too: closing an issue takes it.
  mayDecide: async (_db, _payload, approver) =>
    approver.access.permissions.has('issues.resolve'),
  // The runbook's rule: on your own page the route refuses while someone else could, and alone you
  // may, with the alert. So a subject may ask here.
  subjectMayAsk: true,
  subjects: async ({ issueId }, db) => {
    const [issue] = await db
      .select({ subject: issues.subject })
      .from(issues)
      .where(eq(issues.id, issueId));
    const { profileId, userId } = issue?.subject ?? {};
    const payout = await payoutCaseFacts(db, issueId);
    return [
      ...(userId ? [userId] : []),
      ...(profileId ? await pageOwner(db, profileId) : []),
      ...(payout ? await payoutOwners(db, payout.owner) : []),
    ];
  },
  target: ({ issueId }) => issueId,
  describe: async (tx, { issueId, outcome, bankAndSignInChecked }) => {
    const [issue] = await tx
      .select({ kind: issues.kind })
      .from(issues)
      .where(eq(issues.id, issueId));
    if (!issue) throw new OperationError('ISSUE_NOT_FOUND');
    return `Close the money issue ending ${issueId.slice(-6)} (${issue.kind.replaceAll('_', ' ')}) as: ${
      outcome ? OPS_ISSUE_OUTCOME_WORDS[outcome] : 'no outcome given'
    }${bankAndSignInChecked ? '. Bank and sign-in checked with the real owner' : ''}`;
  },
  act: async (tx, { issueId, outcome, bankAndSignInChecked }, context) => {
    const access = await readStaffAccess(tx, context.actorId);
    if (!access?.permissions.has('issues.resolve'))
      throw new OperationError('PERMISSION_NOT_HELD');
    const [issue] = await tx
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    if (issue?.status !== 'open') throw new OperationError('ISSUE_RESOLVED');
    const closed = await resolveIssue(tx, {
      issueId,
      staffUserId: context.actorId,
      reason: context.reason,
      ...(outcome ? { outcome } : {}),
      ...(bankAndSignInChecked === undefined ? {} : { bankAndSignInChecked }),
      now: context.now,
    });
    return { resolved: true, ...closed };
  },
});

const feeChange = acting<{ profileId: string; feeBps: number | null }>({
  name: 'fee.change',
  permission: 'fees.manage',
  subjects: ({ profileId }, db) => pageOwner(db, profileId),
  target: ({ profileId }) => profileId,
  current: async (tx, { profileId }) => {
    const [page] = await tx
      .select({ feeBps: profiles.customFeeBps })
      .from(profiles)
      .where(eq(profiles.id, profileId));
    return page?.feeBps ?? null;
  },
  describe: async (tx, { profileId, feeBps }) =>
    `Set @${await handleOf(tx, profileId)}'s fee to ${
      feeBps === null ? 'the standard fee' : `${feeBps / 100}%`
    }`,
  act: (tx, { profileId, feeBps }, context) =>
    setAccountFee(tx, {
      staffUserId: context.actorId,
      profileId,
      feeBps,
      reason: context.reason,
    }).then(({ handle }) => ({ revalidateHandle: handle.toLowerCase() })),
});

const feeFree = acting<{ profileId: string; count: number }>({
  name: 'fee.free',
  permission: 'fees.manage',
  subjects: ({ profileId }, db) => pageOwner(db, profileId),
  target: ({ profileId }) => profileId,
  describe: async (tx, { profileId, count }) =>
    `Give @${await handleOf(tx, profileId)} ${count} fee-free tips`,
  act: (tx, { profileId, count }, context) =>
    grantFeeFreeTips(tx, {
      staffUserId: context.actorId,
      profileId,
      count,
      reason: context.reason,
    }),
});

/*
 * Paid Pro (ADR-0015): the monthly price. Pinned on the current price, so a change made while this
 * waited makes it stale. Nobody is its subject: it applies to every new month.
 */
const proPriceChange = acting<{ amountMinor: string }>({
  name: 'pro_price.change',
  permission: 'pro.price',
  target: () => 'pro_price',
  current: async (tx) => {
    const price = await currentProPrice(tx);
    return price
      ? { id: price.id, amountMinor: String(price.amountMinor) }
      : null;
  },
  describe: async (tx, { amountMinor }) => {
    const to = checkedProPrice(amountMinor);
    const from = await currentProPrice(tx);
    return `Change the Pro price ${from ? `from ${nairaOf(from.amountMinor)} ` : ''}to ${nairaOf(to)} a month, for new months only`;
  },
  act: (tx, { amountMinor }, context) =>
    setProPrice(tx, {
      amountMinor: checkedProPrice(amountMinor),
      staffUserId: context.actorId,
      approvedBy: context.approverId ?? null,
      reason: context.reason,
      now: context.now,
    }).then((set) => ({
      id: set.id,
      amountMinor: String(set.amountMinor),
    })),
});

/*
 * Business Pro (plan Task A5): the business monthly price, exactly like `pro_price.change` but on
 * plan 'business'. Pinned on the current business price only, so a personal change never makes it
 * stale (and the other way round).
 */
const businessProPriceChange = acting<{ amountMinor: string }>({
  name: 'business_pro_price.change',
  permission: 'pro.price',
  target: () => 'business_pro_price',
  current: async (tx) => {
    const price = await currentProPrice(tx, new Date(), 'business');
    return price
      ? { id: price.id, amountMinor: String(price.amountMinor) }
      : null;
  },
  describe: async (tx, { amountMinor }) => {
    const to = checkedProPrice(amountMinor);
    const from = await currentProPrice(tx, new Date(), 'business');
    return `Change the Business Pro price ${from ? `from ${nairaOf(from.amountMinor)} ` : ''}to ${nairaOf(to)} a month, for new months only`;
  },
  act: (tx, { amountMinor }, context) =>
    setProPrice(tx, {
      amountMinor: checkedProPrice(amountMinor),
      plan: 'business',
      staffUserId: context.actorId,
      approvedBy: context.approverId ?? null,
      reason: context.reason,
      now: context.now,
    }).then((set) => ({
      id: set.id,
      amountMinor: String(set.amountMinor),
    })),
});

/**
 * Paid Pro, plan Task 9 (ruling 6): refund a card-paid Pro month, on the member's request, within
 * 14 days. A second person decides; neither the page's owner nor anyone behind its mailbox can.
 * Pinned on the payment's refund state, so a refund already asked or paid makes it stale. The run
 * only records the refund: the worker sends it, and only the partner's refund.paid ends Pro.
 */
const proRefund = acting<{ purchaseId: string }>({
  name: 'pro.refund',
  permission: 'payments.repair',
  subjects: async ({ purchaseId }, db) => {
    const facts = await proRefundFacts(db, purchaseId, new Date());
    if (facts.businessId) return openBusinessOwners(db, facts.businessId);
    return facts.profileId ? pageOwner(db, facts.profileId) : [];
  },
  target: ({ purchaseId }) => purchaseId,
  current: async (tx, { purchaseId }) => {
    const facts = await proRefundFacts(tx, purchaseId, new Date());
    return { refund: facts.refund?.status ?? null };
  },
  describe: async (tx, { purchaseId }) => {
    const facts = await proRefundFacts(tx, purchaseId, new Date());
    const paidOn = facts.paidAt
      ? facts.paidAt.toISOString().slice(0, 10)
      : 'an unknown day';
    return `Refund ${naira(facts.amountMinor ?? 0n)} of the Pro card payment ending ${purchaseId.slice(-6)} (paid ${paidOn}) on the member's request. Their Pro month ends when the payment partner confirms the refund; the card fee isn't returned.`;
  },
  act: (tx, { purchaseId }, context) =>
    askProRefund(tx, {
      purchaseId,
      staffUserId: context.actorId,
      approvedBy: context.approverId ?? null,
      reason: context.reason,
      now: context.now,
    }),
});

/* TipMe for businesses */

/**
 * Verifying makes a business's printed codes live (PR B2). Pinned on its status and slug: a slug
 * corrected, or the business suspended, after asking makes the approval stale. The business's own
 * managers can't decide it, even when they are staff.
 */
const businessVerify = acting<{ businessId: string }>({
  name: 'business.verify',
  permission: 'businesses.manage',
  subjects: ({ businessId }, db) => businessManagerUsers(db, businessId),
  target: ({ businessId }) => businessId,
  current: (tx, { businessId }) => businessVerifyFacts(tx, businessId),
  describe: async (tx, { businessId }) => {
    const facts = await opsBusinessName(tx, businessId);
    return `Verify ${facts.name} (usetipme.xyz/b/${facts.slug}) so its codes go live.`;
  },
  act: (tx, { businessId }, context) =>
    verifyBusiness(tx, {
      businessId,
      staffUserId: context.actorId,
      reason: context.reason,
      now: context.now,
    }).then(({ slug }) => ({ revalidateBusiness: slug })),
});

const opsBusinessName = async (db: Database | Tx, businessId: string) => {
  const [row] = await db
    .select({ name: businesses.name, slug: businesses.slug })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  if (!row) throw new OperationError('BUSINESS_NOT_FOUND');
  return row;
};
/* Business release 2: reversals (Q7, Q8) */

export interface TipReversePayload {
  /** The open `payment_reversed` issue the partner's refund or chargeback raised. */
  issueId: string;
  tipId: string;
  /** The partner's refund or dispute (`refund.<id>`), as the issue names it: one reversal each. */
  partnerReversalId: string;
  /** Minor units, as a decimal string (JSON has no bigint). */
  refundedMinor: string;
}

const naira = (minor: bigint) =>
  `NGN ${(minor / 100n).toLocaleString('en-NG')}.${(minor % 100n).toString().padStart(2, '0')}`;

/** Why a reversal was refused, in words for the issue's notes (never a balance or a name). */
const REVERSAL_REFUSALS: Record<string, string> = {
  already_reversed_this:
    'Reversal refused: this refund or dispute was already reversed. Nothing was posted. A separate refund or dispute from the partner opens its own issue.',
  not_paid_yet:
    'Reversal refused: the partner has not reported this refund as paid. Nothing was posted. Wait for it to be paid.',
  amount_differs:
    'Reversal refused: the amount entered differs from what the partner reports this refund gave back. Nothing was posted. Check the partner’s dashboard.',
  flags_off:
    'Reversal refused: business shares are switched off, so TipMe books no reversal. Nothing was posted.',
  already_reversed:
    'Reversal refused: everything this tip paid was already taken back by an earlier refund or chargeback. Nothing was posted.',
  more_than_left:
    'Reversal refused: the amount is more than what is left of this tip after earlier refunds or chargebacks. Nothing was posted. Check the partner’s dashboard for what this event took back.',
  not_paid:
    'Reversal refused: this tip has no payment in the ledger. Nothing was posted.',
};

/**
 * Staff take back a refunded or charged-back tip, every line of it: the person's part and any
 * business's part (Q7). Never automatic: only from the partner's own `payment_reversed` issue, after
 * checking the partner's dashboard, because the event doesn't say whether a refund is partial. It
 * posts even after the money was withdrawn (Q8). It moves no money at the partner: TipMe records it.
 */
const tipReverse = acting<TipReversePayload>({
  name: 'tip.reverse',
  permission: 'payments.repair',
  // Neither the person tipped nor anyone running the business can decide their own reversal.
  subjects: async ({ tipId }, db) => {
    const [tip] = await db
      .select({
        profileId: tips.profileId,
        businessId: tipBusinessShares.businessId,
      })
      .from(tips)
      .leftJoin(tipBusinessShares, eq(tipBusinessShares.tipId, tips.id))
      .where(eq(tips.id, tipId));
    const managers = tip?.businessId
      ? await db
          .select({ userId: businessManagers.userId })
          .from(businessManagers)
          .where(eq(businessManagers.businessId, tip.businessId))
      : [];
    return [
      ...(tip?.profileId ? await pageOwner(db, tip.profileId) : []),
      ...managers.map(({ userId }) => userId),
    ];
  },
  target: ({ tipId }) => tipId,
  // Pinned to the tip's status and to how much of it was already taken back.
  current: async (tx, { tipId }) => {
    const [tip] = await tx
      .select({ status: tips.status })
      .from(tips)
      .where(eq(tips.id, tipId));
    return {
      status: tip?.status ?? null,
      reversedMinor: (await reversalsOf(tx, tipId)).reversedMinor.toString(),
    };
  },
  // The approver sees what earlier refunds or disputes already took back (R2-A review finding 1).
  describe: async (tx, { tipId, refundedMinor }) => {
    const { count, reversedMinor } = await reversalsOf(tx, tipId);
    const earlier =
      count === 0
        ? 'Nothing was taken back from this tip before'
        : `Already taken back from this tip: ${naira(reversedMinor)} in ${count} reversal${count === 1 ? '' : 's'}`;
    return `Reverse ${naira(BigInt(refundedMinor))} of the tip ending ${tipId.slice(-6)}, as the payment partner refunded or charged it back: the person's part and any business's part, in proportion. ${earlier}`;
  },
  act: async (tx, payload, context) => {
    const [issue] = await tx
      .select({
        kind: issues.kind,
        status: issues.status,
        subject: issues.subject,
      })
      .from(issues)
      .where(eq(issues.id, payload.issueId));
    if (!issue) throw new OperationError('ISSUE_NOT_FOUND');
    if (issue.status !== 'open') throw new OperationError('ISSUE_RESOLVED');
    if (
      issue.kind !== 'payment_reversed' ||
      issue.subject.tipId !== payload.tipId
    )
      throw new OperationError('INVALID_INPUT');
    // Approval may come after the flags were turned off: then nothing posts (review finding 3).
    if (!context.services?.businessSharesEnabled)
      throw new OperationError('TIP_NOT_REVERSIBLE', 'flags_off');
    // Each partner refund or dispute is reversed once; a second request for it is refused.
    if (await alreadyReversed(tx, payload.partnerReversalId))
      throw new OperationError('TIP_NOT_REVERSIBLE', 'already_reversed_this');
    // A paid refund is reversed for exactly what the partner says it gave back, with its own fee;
    // staff enter the amount from the partner's dashboard, and it must match.
    const { refundState, refundedMinor, refundFeeMinor } = issue.subject;
    if (
      issue.subject.partnerReversalId !== payload.partnerReversalId ||
      (payload.partnerReversalId.startsWith('refund.') &&
        (refundState !== 'paid' || !refundedMinor))
    )
      throw new OperationError('TIP_NOT_REVERSIBLE', 'not_paid_yet');
    if (refundedMinor && refundedMinor !== payload.refundedMinor)
      throw new OperationError('TIP_NOT_REVERSIBLE', 'amount_differs');
    const result = await reverseTip(tx, {
      tipId: payload.tipId,
      partnerReversalId: payload.partnerReversalId,
      refundFeeMinor: BigInt(refundFeeMinor ?? '0'),
      refundedMinor: BigInt(payload.refundedMinor),
      now: context.now,
    });
    return {
      reversed: true as const,
      posted: result.created,
      belowZero: result.belowZero.length > 0,
    };
  },
  // A refusal says why on the issue, so the next person sees it was tried (and nothing posted).
  afterRefusal: async (db, { issueId }, { detail }, check) => {
    const text = detail ? REVERSAL_REFUSALS[detail] : undefined;
    if (!text) return;
    await addIssueNote(db, { issueId, staffUserId: check.actorId, text });
  },
});
/* Staff access */

export type GrantPayload =
  | { kind: 'add'; email: string; roleId: string }
  | { kind: 'role'; userId: string; roleId: string }
  | {
      kind: 'access';
      userId: string;
      additions: string[];
      removals: string[];
    };

const grantSubjects = (payload: GrantPayload, db: Database | Tx) =>
  payload.kind === 'add'
    ? accountOfEmail(db, payload.email)
    : Promise.resolve([payload.userId]);

const grantAfterClose = (payload: GrantPayload): GrantPayload =>
  payload.kind === 'add'
    ? { ...payload, email: maskEmail(payload.email) }
    : payload;

const grantTarget = (payload: GrantPayload) =>
  payload.kind === 'add' ? `email:${payload.email}` : `user:${payload.userId}`;

const sorted = (names: Iterable<string>) => [...names].sort();

interface AccessEffect {
  gains: string[];
  losses: string[];
}

const effectOf = (
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): AccessEffect => ({
  gains: sorted([...after].filter((p) => !before.has(p))),
  losses: sorted([...before].filter((p) => !after.has(p))),
});

/** What replacing a person's adjustments with these would change. */
async function accessEffect(
  db: Database | Tx,
  userId: string,
  additions: readonly string[],
  removals: readonly string[],
): Promise<AccessEffect> {
  const before = await readStaffAccess(db, userId);
  if (!before) return { gains: [], losses: [] };
  const after = new Set([
    ...(await readRolePermissions(db, before.roleId)),
    ...additions,
  ]);
  for (const permission of removals) after.delete(permission);
  return effectOf(before.permissions, after);
}

/** What moving a person to this role would change: adjustments stay, except moving to owner. */
async function roleMoveEffect(
  db: Database | Tx,
  userId: string,
  roleId: string,
): Promise<AccessEffect> {
  const before = await readStaffAccess(db, userId);
  if (!before) return { gains: [], losses: [] };
  const next = await readRolePermissions(db, roleId);
  const after = composeAccess(
    roleId,
    next,
    roleId === 'owner' ? [] : await readOverrides(db, userId),
  );
  return effectOf(before.permissions, after.permissions);
}

/** Sorted: the words are compared at approval, and a table's row order isn't fixed. */
const effectWords = ({ gains, losses }: AccessEffect) => {
  const parts = [
    ...(gains.length ? [`gains ${gains.join(', ')}`] : []),
    ...(losses.length ? [`loses ${losses.join(', ')}`] : []),
  ];
  return parts.length ? parts.join('; ') : 'what they hold stays the same';
};

// The change itself, by comparing before and after: re-ticking a removed permission sends no
// adjustments at all, and hands the permission back.
const grantDescribe = async (tx: Tx, payload: GrantPayload) => {
  if (payload.kind === 'add') {
    const holds = sorted(await readRolePermissions(tx, payload.roleId));
    return `Add ${maskEmail(payload.email)} as staff with the role ${await roleName(tx, payload.roleId)}, which holds ${holds.join(', ') || 'nothing'}`;
  }
  const who = await personHint(tx, payload.userId);
  if (payload.kind === 'role')
    return `Move ${who} to the role ${await roleName(tx, payload.roleId)}: ${effectWords(await roleMoveEffect(tx, payload.userId, payload.roleId))}`;
  return `Change ${who}'s personal access: ${effectWords(await accessEffect(tx, payload.userId, payload.additions, payload.removals))}`;
};

/** The role a grant hands out moved, or the person's access did: the request stops. */
const grantCurrent = async (tx: Tx, payload: GrantPayload) => {
  if (payload.kind === 'add')
    return { role: await roleStamp(tx, payload.roleId) };
  const access = await readStaffAccess(tx, payload.userId);
  if (payload.kind === 'role')
    return {
      role: await roleStamp(tx, payload.roleId),
      from: access?.roleId ?? null,
    };
  const overrides = await readOverrides(tx, payload.userId);
  return {
    role: access ? await roleStamp(tx, access.roleId) : null,
    from: access?.roleId ?? null,
    overrides: overrides.map((row) => `${row.effect}:${row.permission}`).sort(),
  };
};

function grantAct(tx: Tx, payload: GrantPayload, context: SeriousActionCheck) {
  const { actorId, reason } = context;
  if (payload.kind === 'add')
    return addStaff(tx, {
      actorId,
      email: payload.email,
      roleId: payload.roleId,
      reason,
      sealing: servicesOf(context).sealing,
      now: context.now,
    });
  if (payload.kind === 'role')
    return changeRole(tx, {
      actorId,
      userId: payload.userId,
      roleId: payload.roleId,
      reason,
    });
  return setPersonalAccess(tx, {
    actorId,
    userId: payload.userId,
    additions: payload.additions,
    removals: payload.removals,
    reason,
  });
}

const grantOwnerAction = acting<GrantPayload>({
  name: 'staff.grant_owner',
  permission: 'staff.manage',
  mayDecide: async (_db, _payload, approver) => isOwner(approver),
  subjects: grantSubjects,
  afterClose: grantAfterClose,
  target: grantTarget,
  current: grantCurrent,
  describe: grantDescribe,
  act: grantAct,
});

/** What personal adjustments would leave them holding that they don't hold now. */
const accessGains = async (
  db: Database | Tx,
  userId: string,
  additions: readonly string[],
  removals: readonly string[],
) => (await accessEffect(db, userId, additions, removals)).gains;

/** What the person would be given: someone who doesn't hold it all can't decide it. */
const permissionsGranted = async (db: Database | Tx, payload: GrantPayload) =>
  payload.kind === 'access'
    ? accessGains(db, payload.userId, payload.additions, payload.removals)
    : readRolePermissions(db, payload.roleId);

const grantSensitive = acting<GrantPayload>({
  name: 'staff.grant_sensitive',
  permission: 'staff.manage',
  mayDecide: async (db, payload, approver) =>
    (await permissionsGranted(db, payload)).every((permission) =>
      approver.access.permissions.has(permission),
    ),
  subjects: grantSubjects,
  afterClose: grantAfterClose,
  target: grantTarget,
  current: grantCurrent,
  describe: grantDescribe,
  act: grantAct,
});

export interface RoleEditPayload {
  roleId: string;
  name?: string;
  description?: string;
  permissions: string[];
}

const addedBy = async (db: Database | Tx, payload: RoleEditPayload) => {
  const stored = new Set(await readRolePermissions(db, payload.roleId));
  return payload.permissions.filter((permission) => !stored.has(permission));
};

const roleAddSensitive = acting<RoleEditPayload>({
  name: 'role.add_sensitive',
  permission: 'staff.manage',
  mayDecide: async (db, payload, approver) =>
    (await addedBy(db, payload)).every((permission) =>
      approver.access.permissions.has(permission),
    ),
  // Everyone on the role gains it.
  subjects: async ({ roleId }, db) => {
    const people = await db
      .select({ userId: staff.userId })
      .from(staff)
      .where(and(eq(staff.roleId, roleId), isNull(staff.revokedAt)));
    return people.map((person) => person.userId);
  },
  target: ({ roleId }) => roleId,
  current: (tx, { roleId }) => roleStamp(tx, roleId),
  // The run replaces the whole list, so the words name what goes as well as what comes, and the
  // run also writes any new name and description.
  describe: async (tx, payload) => {
    const stored = await readRolePermissions(tx, payload.roleId);
    const removed = stored.filter((p) => !payload.permissions.includes(p));
    const changes = [
      `add ${sorted(await addedBy(tx, payload)).join(', ') || 'nothing'}`,
      ...(removed.length ? [`remove ${sorted(removed).join(', ')}`] : []),
      ...(payload.name === undefined ? [] : [`rename it to "${payload.name}"`]),
      ...(payload.description === undefined
        ? []
        : [`describe it as "${payload.description}"`]),
    ];
    return `In the role ${await roleName(tx, payload.roleId)}: ${changes.join('; ')}`;
  },
  act: (tx, payload, context) =>
    updateRole(tx, {
      actorId: context.actorId,
      roleId: payload.roleId,
      reason: context.reason,
      permissions: payload.permissions,
      ...(payload.name === undefined ? {} : { name: payload.name }),
      ...(payload.description === undefined
        ? {}
        : { description: payload.description }),
    }),
});

const staffResetAuthenticator = acting<{ userId: string }>({
  name: 'staff.reset_authenticator',
  permission: 'staff.manage',
  mayDecide: async (_db, _payload, approver) => isOwner(approver),
  subjects: ({ userId }) => [userId],
  target: ({ userId }) => userId,
  describe: async (tx, { userId }) =>
    `Reset the authenticator of ${await personHint(tx, userId)} and email them a new link`,
  act: (tx, { userId }, context) =>
    resetAuthenticator(tx, {
      actorId: context.actorId,
      userId,
      reason: context.reason,
      sealing: servicesOf(context).sealing,
      now: context.now,
    }),
});

/* Mail provider */

const mailProviderSwitch = acting<{ provider: MailProviderName }>({
  name: 'mail_provider.switch',
  permission: 'providers.manage',
  prepare: async (_db, { provider }, { services }) => {
    const mail = servicesOf({ services }).mail;
    if (!mail) throw new OperationError('INVALID_INPUT');
    const status = await mail.status(provider);
    // In production a provider whose status can't be read is not switched to blind.
    if (mail.production && !status)
      throw new OperationError('PROVIDER_STATUS_UNKNOWN');
    return { sandbox: status?.sandbox ?? null };
  },
  current: async (tx) => {
    const [row] = await tx
      .select({ provider: providerSettings.activeProvider })
      .from(providerSettings)
      .where(eq(providerSettings.kind, 'mail'));
    return row?.provider ?? null;
  },
  describe: async (_tx, { provider }) =>
    `Make ${provider} the active email provider`,
  act: async (tx, { provider }, context) => {
    const mail = servicesOf(context).mail;
    if (!mail) throw new OperationError('INVALID_INPUT');
    const { sandbox } = context.facts as { sandbox: boolean | null };
    if (!(await hasConfirmedMailTest(tx, provider, context.now)))
      throw new OperationError('NO_CONFIRMED_TEST');
    const outcome = await switchMailProvider(tx, {
      staffUserId: context.actorId,
      provider,
      reason: context.reason,
      production: mail.production,
      sandbox,
      configured: mail.configured,
      fallback: mail.fallback,
      now: context.now,
    });
    if (outcome === 'no_confirmed_test')
      throw new OperationError('NO_CONFIRMED_TEST');
    if (outcome !== 'switched')
      throw new OperationError('PROVIDER_NOT_ALLOWED');
    return { provider };
  },
});

let registered = false;

/** Safe to call more than once; registering is what the API and the worker do at start. */
export function registerRealSeriousActions(): void {
  if (registered) return;
  registered = true;
  registerSeriousAction(emailRecovery);
  registerSeriousAction(payoutSettle);
  registerSeriousAction(moneyIssueClose);
  registerSeriousAction(feeChange);
  registerSeriousAction(feeFree);
  registerSeriousAction(grantOwnerAction);
  registerSeriousAction(grantSensitive);
  registerSeriousAction(roleAddSensitive);
  registerSeriousAction(staffResetAuthenticator);
  registerSeriousAction(mailProviderSwitch);
  registerSeriousAction(takeBackAction);
  registerSeriousAction(businessVerify);
  registerSeriousAction(tipReverse);
  registerSeriousAction(changelogPublishAction);
  registerSeriousAction(proPriceChange);
  registerSeriousAction(proRefund);
  registerSeriousAction(businessProPriceChange);
}

/* Routes whose seriousness depends on what is being done */

export type AppliedOrAsked<Result> =
  { state: 'applied'; result: Result } | SeriousActionOutcome;

type Asking = {
  actorId: string;
  grantId: string;
  reason: string;
  services: SeriousActionServices;
};

/**
 * Decides under the lock, and applies there too, so a role that gains a sensitive permission just
 * now can't slip through as harmless. Anything serious goes the long way, after this lets go.
 */
async function applyUnlessSerious<Result>(
  db: Database,
  decide: (tx: Tx) => Promise<{ name: string; payload: unknown } | null>,
  apply: (tx: Tx) => Promise<Result>,
  asking: Asking,
): Promise<AppliedOrAsked<Result>> {
  const first = await guarded(() =>
    db.transaction(async (tx) => {
      await lockStaffAdmin(tx);
      return whileHoldingStaffAdmin(async () => {
        const serious = await decide(tx);
        if (serious) return { serious };
        return { applied: await apply(tx) };
      });
    }),
  );
  if ('applied' in first)
    return { state: 'applied', result: first.applied as Result };
  // Only what asking means: a caller's input can also hold a field called `name` (a role's).
  const { actorId, grantId, reason, services } = asking;
  return requestSeriousAction(db, {
    ...first.serious,
    actorId,
    grantId,
    reason,
    services,
  });
}

const hasSensitive = (permissions: readonly string[]) =>
  permissions.some(isSensitive);

async function grantNameForRole(tx: Tx, roleId: string) {
  if (roleId === 'owner') return 'staff.grant_owner';
  return hasSensitive(await readRolePermissions(tx, roleId))
    ? 'staff.grant_sensitive'
    : null;
}

export function addStaffOrAsk(
  db: Database,
  input: Asking & { email: string; roleId: string },
) {
  const email = normaliseEmail(input.email);
  if (!email) return Promise.reject(new OperationError('INVALID_INPUT'));
  const { roleId, ...asking } = input;
  return applyUnlessSerious(
    db,
    async (tx) => {
      const name = await grantNameForRole(tx, roleId);
      return name
        ? {
            name,
            payload: { kind: 'add', email, roleId } satisfies GrantPayload,
          }
        : null;
    },
    (tx) =>
      addStaff(tx, {
        actorId: input.actorId,
        email,
        roleId,
        reason: input.reason,
        sealing: input.services.sealing,
      }),
    asking,
  );
}

export function changeRoleOrAsk(
  db: Database,
  input: Asking & { userId: string; roleId: string },
) {
  const { userId, roleId } = input;
  return applyUnlessSerious(
    db,
    async (tx) => {
      const name = await grantNameForRole(tx, roleId);
      return name
        ? {
            name,
            payload: { kind: 'role', userId, roleId } satisfies GrantPayload,
          }
        : null;
    },
    (tx) =>
      changeRole(tx, {
        actorId: input.actorId,
        userId,
        roleId,
        reason: input.reason,
      }),
    input,
  );
}

/** Serious when it leaves them holding a sensitive permission they didn't have, however it's done. */
export function setPersonalAccessOrAsk(
  db: Database,
  input: Asking & {
    userId: string;
    additions: readonly string[];
    removals: readonly string[];
  },
) {
  const { userId, additions, removals } = input;
  return applyUnlessSerious(
    db,
    async (tx) => {
      const gains = await accessGains(tx, userId, additions, removals);
      return hasSensitive(gains)
        ? {
            name: 'staff.grant_sensitive',
            payload: {
              kind: 'access',
              userId,
              additions: [...additions],
              removals: [...removals],
            } satisfies GrantPayload,
          }
        : null;
    },
    (tx) =>
      setPersonalAccess(tx, {
        actorId: input.actorId,
        userId,
        additions,
        removals,
        reason: input.reason,
      }),
    input,
  );
}

export function updateRoleOrAsk(
  db: Database,
  input: Asking & {
    roleId: string;
    name?: string;
    description?: string;
    permissions?: readonly string[];
  },
) {
  const { roleId, name, description, permissions } = input;
  const named = {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  };
  return applyUnlessSerious(
    db,
    async (tx) => {
      if (!permissions) return null;
      const stored = new Set(await readRolePermissions(tx, roleId));
      return hasSensitive(permissions.filter((p) => !stored.has(p)))
        ? {
            name: 'role.add_sensitive',
            payload: {
              roleId,
              permissions: [...permissions],
              ...named,
            } satisfies RoleEditPayload,
          }
        : null;
    },
    (tx) =>
      updateRole(tx, {
        actorId: input.actorId,
        roleId,
        reason: input.reason,
        ...named,
        ...(permissions ? { permissions } : {}),
      }),
    input,
  );
}
