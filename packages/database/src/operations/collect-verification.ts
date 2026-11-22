import { createHash, createHmac, hkdfSync } from 'node:crypto';
import {
  COLLECT_NAME_RECHECK_NOTICE,
  collectLegalNameSchema,
  recordedProviderName,
  type CollectBankState,
  type CollectBankView,
  type CollectLegalName,
} from '@tipme/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  issues,
  notifications,
  paymentAccounts,
  payoutDestinations,
  profiles,
} from '../schema.js';
import { mailOwner } from './account-mail.js';
import { recordAudit } from './audit.js';
import { idFromKey } from './collect-guards.js';
import { releaseWaitingTransfers } from './collect-transfers.js';
import type { CollectionMode } from './collection-mode.js';
import { guarded, OperationError } from './errors.js';
import { openIssue } from './issues.js';
import type { MailSealing } from './mail-queue.js';
import {
  getPayoutDestination,
  refreshPendingDestination,
  type PayoutDestinationStatus,
  type PayoutSetupLog,
} from './payout-destinations.js';

/*
 * You collect: adding bank details (plan Task 13; spec §2.1 steps 4–5, §8; rulings R7, R8, P12, P13,
 * P32). The recipient gives their legal name and a bank account in that name; our payment partner
 * compares the bank's name with theirs. Verified means a `usable` bank and the account's `transfers`
 * (and `payouts`) capability active: `collect_verified_at` is set then, exactly once, which locks the
 * legal name (support changes it, `collect_name.change`), lifts the holding cap and releases the held
 * shares. A bank account already used by another recipient opens `collect_same_bank`, and that
 * recipient's shares wait for review. The account number is never stored: only its last four digits
 * and a keyed hash of bank and number (`payout_destinations.account_hash`).
 */

/** What the bank-details routes need to know about a recipient. Never returned as it is. */
export interface CollectBankFacts {
  mode: CollectionMode;
  verifiedAt: Date | null;
  /** The legal name TipMe holds: the one its current bank was checked against, or null. */
  legalName: CollectLegalName | null;
  /** The digest of the name our payment partner last confirmed holding, or null. */
  partnerNameDigest: string | null;
  /**
   * Task 15: support changed the locked name, and our payment partner hasn't checked the current
   * bank against it yet. Nothing more is transferred meanwhile.
   */
  nameRecheckAt: Date | null;
}

/** The stored name (JSON `{ first, last }`), or null when absent or unreadable. */
function parseLegalName(stored: string | null): CollectLegalName | null {
  if (!stored) return null;
  try {
    const parsed = collectLegalNameSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const storedName = (name: CollectLegalName) =>
  JSON.stringify({ first: name.first.trim(), last: name.last.trim() });

/** One way of writing a name: trimmed, single spaces, case folded. */
const folded = (part: string) =>
  part.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');

/** Whether two legal names are the same person's name as typed (case and spacing aside). */
export function sameLegalName(
  a: CollectLegalName | null,
  b: CollectLegalName,
): boolean {
  return (
    a !== null &&
    folded(a.first) === folded(b.first) &&
    folded(a.last) === folded(b.last)
  );
}

export function collectBankFacts(
  db: Database | Tx,
  profileId: string,
): Promise<CollectBankFacts> {
  return guarded(async () => {
    const [row] = await db
      .select({
        mode: profiles.collectionMode,
        verifiedAt: profiles.collectVerifiedAt,
        legalName: profiles.collectLegalName,
        partnerNameDigest: profiles.collectPartnerNameDigest,
        nameRecheckAt: profiles.collectNameRecheckAt,
      })
      .from(profiles)
      .where(eq(profiles.id, profileId));
    if (!row) throw new OperationError('PROFILE_NOT_FOUND');
    return {
      mode: row.mode === 'collect' ? 'collect' : 'direct',
      verifiedAt: row.verifiedAt,
      legalName: parseLegalName(row.legalName),
      partnerNameDigest: row.partnerNameDigest,
      nameRecheckAt: row.nameRecheckAt,
    };
  });
}

const keyOf = (sealing: MailSealing, purpose: string) =>
  Buffer.from(hkdfSync('sha256', sealing.key, '', purpose, 32));

/**
 * The keyed hash of a bank account (P13): HMAC-SHA256 of bank code and number under a key derived
 * from the sealing key, as the secret-box pattern derives its keys. Ten digits alone could be found
 * by trying them all, so it is never a plain hash. Equal for the same account on any profile.
 */
export function bankAccountHash(
  sealing: MailSealing,
  bankCode: string,
  accountNumber: string,
): string {
  return createHmac('sha256', keyOf(sealing, 'collect-bank-account'))
    .update(`${bankCode.trim()}|${accountNumber.trim()}`)
    .digest('hex');
}

/**
 * A legal name's digest (case and spacing aside), to bind a name to the check our payment partner
 * made (fix C1) and to know whether the partner already holds it (fix I1). Unkeyed: the name it
 * stands for sits beside it in the same row set, so a key would hide nothing.
 */
export function legalNameDigest(name: CollectLegalName): string {
  return createHash('sha256')
    .update(`${folded(name.first)}\n${folded(name.last)}`)
    .digest('hex');
}

/** Records what the partner now holds for this person (null: unknown, so the next add sends it). */
export function recordPartnerName(
  db: Database,
  input: { profileId: string; legalName: CollectLegalName | null },
): Promise<void> {
  return guarded(async () => {
    await db
      .update(profiles)
      .set({
        collectPartnerNameDigest: input.legalName
          ? legalNameDigest(input.legalName)
          : null,
      })
      .where(eq(profiles.id, input.profileId));
  });
}

/**
 * Keeps the legal name just given to our payment partner. Before verification it may change (a
 * typo, a different spelling) or be cleared (null: a name the partner refused is not kept); once
 * verified it is locked, and only the same name passes.
 */
export function recordCollectLegalName(
  db: Database,
  input: { profileId: string; legalName: CollectLegalName | null },
): Promise<void> {
  const parsed =
    input.legalName === null
      ? null
      : collectLegalNameSchema.safeParse(input.legalName);
  if (parsed && !parsed.success)
    return Promise.reject(new OperationError('INVALID_INPUT'));
  const name = parsed?.data ?? null;
  return guarded(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          verifiedAt: profiles.collectVerifiedAt,
          legalName: profiles.collectLegalName,
        })
        .from(profiles)
        .where(eq(profiles.id, input.profileId))
        .for('update');
      if (!row) throw new OperationError('PROFILE_NOT_FOUND');
      if (row.verifiedAt) {
        if (!name || !sameLegalName(parseLegalName(row.legalName), name))
          throw new OperationError('NAME_LOCKED');
        return;
      }
      await tx
        .update(profiles)
        .set({ collectLegalName: name ? storedName(name) : null })
        .where(eq(profiles.id, input.profileId));
    }),
  );
}

/**
 * The recipient's partner account for collect transfers and bank checks: their payment account in
 * this environment, or, for the pretend provider (no accounts), their profile id.
 */
export function collectAccountReference(
  db: Database | Tx,
  input: {
    profileId: string;
    provider: string;
    environment: 'sandbox' | 'live' | null;
  },
): Promise<string | null> {
  if (input.provider === 'mock') return Promise.resolve(input.profileId);
  const environment = input.environment;
  if (!environment) return Promise.resolve(null);
  return guarded(async () => {
    const [row] = await db
      .select({ reference: paymentAccounts.providerAccountReference })
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.profileId, input.profileId),
          eq(paymentAccounts.provider, recordedProviderName(input.provider)),
          eq(paymentAccounts.environment, environment),
        ),
      );
    return row?.reference ?? null;
  });
}

const SAME_BANK_PREFIX = 'collect_same_bank.';

/**
 * P13 and Review Focus 2: a bank account (by its keyed hash) already used by another recipient. The
 * recipient adding it now is the second: one `collect_same_bank` issue for them and this account,
 * and their shares not yet sent wait in `review` (`same_bank`). While that issue is open nothing more
 * is released to them (`canReceive`), so a tip that arrives later waits too. A share that may have
 * been sent is left alone (P26): its read-back settles it. An issue staff have already closed for
 * this pair is their decision and is not reopened. Returns whether the account is shared.
 */
export function flagSharedBank(
  db: Database,
  input: { profileId: string; accountHash: string; now: Date },
): Promise<boolean> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const others = await tx.execute<{ profile_id: string }>(sql`
        SELECT DISTINCT d.profile_id FROM payout_destinations d
         WHERE d.account_hash = ${input.accountHash}
           AND d.profile_id IS NOT NULL AND d.profile_id <> ${input.profileId}
         ORDER BY d.profile_id`);
      if (others.rows.length === 0) return false;
      const dedupeKey = `${SAME_BANK_PREFIX}${input.profileId}.${input.accountHash.slice(0, 24)}`;
      const ids = others.rows.map((row) => row.profile_id);
      const issue = await openIssue(tx, {
        dedupeKey,
        kind: 'collect_same_bank',
        subject: { profileId: input.profileId },
        note: `The bank account it added is also on ${ids.length === 1 ? 'page' : 'pages'} ${ids.join(', ')}. Its You collect transfers wait until staff clear this.`,
        now: input.now,
      });
      const [state] = await tx
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issue.id));
      if (state?.status !== 'open') return true;
      await tx.execute(sql`
        UPDATE collect_transfers
           SET status = 'review', review_reason = 'same_bank', updated_at = ${input.now.toISOString()}::timestamptz
         WHERE profile_id = ${input.profileId} AND kind = 'share' AND sent_at IS NULL
           AND status IN ('waiting', 'ready')`);
      return true;
    }),
  );
}

/**
 * C1b: whether our payment partner's answer for this destination is proven for another name. A
 * destination is checked against the name it was first saved under: any row of this profile with
 * the same reference (current or replaced) under another digest, or none, means this answer may be a
 * replay decided against that name, and proves nothing about this one.
 */
export function bankCheckedForAnotherName(
  db: Database | Tx,
  input: {
    profileId: string;
    provider: string;
    destinationRef: string;
    nameDigest: string;
  },
): Promise<boolean> {
  return guarded(async () => {
    const result = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM payout_destinations
       WHERE profile_id = ${input.profileId}
         AND provider = ${recordedProviderName(input.provider)}
         AND destination_reference = ${input.destinationRef}
         AND name_digest IS DISTINCT FROM ${input.nameDigest}`);
    return (result.rows[0]?.n ?? 0) > 0;
  });
}

/** What the verification check asks of our payment partner (Task 4's adapter and the mock). */
export interface CollectVerificationProvider {
  name: string;
  payoutCapability(
    accountRef: string,
  ): Promise<{ status: 'active' | 'restricted' | 'missing' }>;
  payoutDestinationStatus(
    accountRef: string,
    destinationRef: string,
  ): Promise<PayoutDestinationStatus>;
}

const stateOf = (
  status: PayoutDestinationStatus,
  verified: boolean,
): CollectBankState | null =>
  status === 'pending_review'
    ? 'manual_review'
    : status === 'usable'
      ? verified
        ? 'verified'
        : 'checking'
      : null;

/** The recipient's bank as they see it, from what is recorded (no partner call). */
export async function collectBankView(
  db: Database,
  input: { profileId: string; provider: string },
): Promise<CollectBankView | null> {
  const facts = await collectBankFacts(db, input.profileId);
  if (facts.mode !== 'collect') return null;
  const current = await getPayoutDestination(db, {
    profileId: input.profileId,
    provider: recordedProviderName(input.provider),
  });
  if (!current) return null;
  // Task 15: a name support changed is checked again with the bank details, so until then the bank
  // is being checked, not verified.
  const state = stateOf(
    current.status,
    facts.verifiedAt !== null && facts.nameRecheckAt === null,
  );
  return state
    ? { state, last4: current.last4, bankName: current.bankName }
    : null;
}

/**
 * Sets `collect_verified_at`, once, in one transaction with its notice: only for a `collect`
 * recipient not yet verified, with a legal name, whose current bank is `usable` and was checked
 * against that very name (the capability was read active just before). Returns whether this call verified them.
 */
async function markVerified(
  db: Database,
  input: {
    profileId: string;
    provider: string;
    sealing?: MailSealing | undefined;
    now: Date;
  },
): Promise<boolean> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          userId: profiles.userId,
          displayName: profiles.displayName,
          mode: profiles.collectionMode,
          verifiedAt: profiles.collectVerifiedAt,
          legalName: profiles.collectLegalName,
        })
        .from(profiles)
        .where(eq(profiles.id, input.profileId))
        .for('update');
      const legalName = parseLegalName(row?.legalName ?? null);
      if (
        !row ||
        row.mode !== 'collect' ||
        row.verifiedAt !== null ||
        !legalName
      )
        return false;
      const [bank] = await tx
        .select({
          status: payoutDestinations.status,
          nameDigest: payoutDestinations.nameDigest,
          destinationRef: payoutDestinations.destinationReference,
        })
        .from(payoutDestinations)
        .where(
          and(
            eq(payoutDestinations.profileId, input.profileId),
            eq(
              payoutDestinations.provider,
              recordedProviderName(input.provider),
            ),
            sql`${payoutDestinations.replacedAt} IS NULL`,
          ),
        )
        .for('share');
      // C1: only the name our payment partner checked this bank against is ever verified.
      const digest = legalNameDigest(legalName);
      if (
        bank?.status !== 'usable' ||
        bank.nameDigest !== digest ||
        // C1b: never on a destination first checked under another name.
        (await bankCheckedForAnotherName(tx, {
          profileId: input.profileId,
          provider: input.provider,
          destinationRef: bank.destinationRef,
          nameDigest: digest,
        }))
      )
        return false;
      await tx
        .update(profiles)
        .set({ collectVerifiedAt: input.now })
        .where(eq(profiles.id, input.profileId));
      // Task 13 M3 (fixed in Task 15): while a shared bank account holds their transfers, "on their
      // way" isn't true yet. The notice goes when staff clear the hold (clearSameBankHold).
      if (!(await sameBankHoldOpen(tx, input.profileId)))
        await tellVerified(tx, {
          profileId: input.profileId,
          sealing: input.sealing,
          now: input.now,
        });
      return true;
    }),
  );
}

/** Whether an open `collect_same_bank` issue holds this recipient's transfers (`canReceive`). */
export async function sameBankHoldOpen(
  tx: Database | Tx,
  profileId: string,
): Promise<boolean> {
  const [open] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.kind, 'collect_same_bank'),
        eq(issues.status, 'open'),
        sql`${issues.subject}->>'profileId' = ${profileId}`,
      ),
    )
    .limit(1);
  return Boolean(open);
}

/**
 * The "Verified" notice (spec §10): in the app, and by email when the sealing key is at hand. Once
 * per recipient (its dedupe key), however often it is called.
 */
export async function tellVerified(
  tx: Tx,
  input: { profileId: string; sealing?: MailSealing | undefined; now: Date },
): Promise<void> {
  const [row] = await tx
    .select({ userId: profiles.userId, displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.id, input.profileId));
  if (!row?.userId) return;
  const dedupeKey = `collect_verified.${input.profileId}`;
  await tx
    .insert(notifications)
    .values({
      id: idFromKey(dedupeKey),
      userId: row.userId,
      kind: 'collect_verified',
      title: 'You’re all set',
      body: 'You’re all set. Your tips are on their way to you.',
      createdAt: input.now,
    })
    .onConflictDoNothing();
  if (input.sealing)
    await mailOwner(tx, input.sealing, {
      profileId: input.profileId,
      type: 'collect_verified',
      data: {
        firstName:
          row.displayName.split(/\s+/)[0] || row.displayName || 'there',
      },
      dedupeKey,
      now: input.now,
    });
}

/**
 * Where a recipient's bank check stands now, finishing it when it can (P12): a bank under review is
 * read again; a `usable` one with the account's capability active verifies them (once) and releases
 * their held shares. Usable without the capability active is `checking`, never `verified`. Called
 * after an add, on `GET /v1/me/collect`, and on the account's events. A failed read changes nothing.
 * Null when they are not on You collect or have no bank under check.
 */
export async function settleCollectVerification(
  db: Database,
  input: {
    profileId: string;
    provider: CollectVerificationProvider;
    accountReference: string | null;
    sealing?: MailSealing | undefined;
    now: Date;
    log?: PayoutSetupLog | undefined;
  },
): Promise<CollectBankState | null> {
  const facts = await collectBankFacts(db, input.profileId);
  if (facts.mode !== 'collect') return null;
  const stored = recordedProviderName(input.provider.name);
  let current = await getPayoutDestination(db, {
    profileId: input.profileId,
    provider: stored,
  });
  if (!current || !input.accountReference)
    return current ? stateOf(current.status, facts.verifiedAt !== null) : null;
  if (current.status === 'pending_review') {
    await refreshPendingDestination(db, input.provider, {
      profileId: input.profileId,
      accountReference: input.accountReference,
      log: input.log,
    });
    current = await getPayoutDestination(db, {
      profileId: input.profileId,
      provider: stored,
    });
    if (!current) return null;
  }
  const rechecking = facts.nameRecheckAt !== null;
  if (current.status !== 'usable')
    return stateOf(current.status, facts.verifiedAt !== null && !rechecking);
  const verified = facts.verifiedAt !== null;
  if (!verified && !facts.legalName) return 'checking';
  // Read now, and that answer decides: shares are only released to an account that can take them.
  let capability: 'active' | 'restricted' | 'missing' | null = null;
  try {
    ({ status: capability } = await input.provider.payoutCapability(
      input.accountReference,
    ));
  } catch (error) {
    input.log?.({
      event: 'collect_bank.capability_read_failed',
      provider: 'bachs',
      error: error instanceof Error ? error.name : typeof error,
    });
  }
  if (capability !== 'active')
    return verified && !rechecking ? 'verified' : 'checking';
  if (
    rechecking &&
    !(await finishNameRecheck(db, input.profileId, input.provider.name))
  )
    return 'checking';
  if (!verified) {
    await markVerified(db, {
      profileId: input.profileId,
      provider: input.provider.name,
      sealing: input.sealing,
      now: input.now,
    });
    if (!(await collectBankFacts(db, input.profileId)).verifiedAt)
      return 'checking';
  }
  // Verified, a usable bank, the account able to receive: whatever waits for them can move now.
  await releaseWaitingTransfers(db, {
    profileId: input.profileId,
    now: input.now,
  });
  return 'verified';
}

/**
 * Task 15: after support changed a locked name, the recipient's current bank must have been checked
 * by our payment partner against that very name (the bank's `name_digest`, never first checked
 * under another name) before anything more is transferred. Clears the recheck once that holds, in
 * one conditional update; returns whether it is clear now.
 */
async function finishNameRecheck(
  db: Database,
  profileId: string,
  provider: string,
): Promise<boolean> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          legalName: profiles.collectLegalName,
          recheckAt: profiles.collectNameRecheckAt,
        })
        .from(profiles)
        .where(eq(profiles.id, profileId))
        .for('update');
      if (!row) return false;
      if (row.recheckAt === null) return true;
      const legalName = parseLegalName(row.legalName);
      if (!legalName) return false;
      const [bank] = await tx
        .select({
          status: payoutDestinations.status,
          nameDigest: payoutDestinations.nameDigest,
          destinationRef: payoutDestinations.destinationReference,
        })
        .from(payoutDestinations)
        .where(
          and(
            eq(payoutDestinations.profileId, profileId),
            eq(payoutDestinations.provider, recordedProviderName(provider)),
            sql`${payoutDestinations.replacedAt} IS NULL`,
          ),
        );
      const digest = legalNameDigest(legalName);
      if (
        bank?.status !== 'usable' ||
        bank.nameDigest !== digest ||
        (await bankCheckedForAnotherName(tx, {
          profileId,
          provider,
          destinationRef: bank.destinationRef,
          nameDigest: digest,
        }))
      )
        return false;
      await tx
        .update(profiles)
        .set({ collectNameRecheckAt: null })
        .where(eq(profiles.id, profileId));
      return true;
    }),
  );
}

/**
 * Fix round 1 (I3): after support changes their name, the recipient's tips wait for a new check, so
 * they are told to add their bank details again: in the app and by email, once per change.
 */
async function tellNameRecheck(
  tx: Tx,
  input: { profileId: string; sealing?: MailSealing | undefined; now: Date },
): Promise<void> {
  const [row] = await tx
    .select({ userId: profiles.userId, displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.id, input.profileId));
  if (!row?.userId) return;
  const dedupeKey = `collect_name_recheck.${input.profileId}.${input.now.getTime()}`;
  await tx
    .insert(notifications)
    .values({
      id: idFromKey(dedupeKey),
      userId: row.userId,
      kind: 'collect_name_recheck',
      ...COLLECT_NAME_RECHECK_NOTICE,
      createdAt: input.now,
    })
    .onConflictDoNothing();
  if (input.sealing)
    await mailOwner(tx, input.sealing, {
      profileId: input.profileId,
      type: 'collect_name_recheck',
      data: {
        firstName:
          row.displayName.split(/\s+/)[0] || row.displayName || 'there',
      },
      dedupeKey,
      now: input.now,
    });
}

/** The `current` a pending name change is pinned on: changes if the name moved, never spells it. */
export async function collectNameStamp(
  db: Database | Tx,
  profileId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ legalName: profiles.collectLegalName })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  return row?.legalName
    ? createHash('sha256').update(row.legalName).digest('hex').slice(0, 16)
    : null;
}

/**
 * Support's change of a verified legal name (`collect_name.change`, a second person): only for a
 * `collect` recipient whose name is locked. The audit row says it changed; neither name goes in it.
 * The new name reaches our payment partner with the recipient's next bank details.
 */
export async function changeCollectLegalName(
  tx: Tx,
  input: {
    profileId: string;
    legalName: CollectLegalName;
    staffUserId: string;
    reason: string;
    now: Date;
    /** To email the recipient (fix round 1, I3); the in-app notice goes either way. */
    sealing?: MailSealing | undefined;
  },
): Promise<{ changed: true }> {
  const parsed = collectLegalNameSchema.safeParse(input.legalName);
  if (!parsed.success) throw new OperationError('INVALID_INPUT');
  const [row] = await tx
    .select({
      mode: profiles.collectionMode,
      verifiedAt: profiles.collectVerifiedAt,
      legalName: profiles.collectLegalName,
    })
    .from(profiles)
    .where(eq(profiles.id, input.profileId))
    .for('update');
  if (!row) throw new OperationError('PROFILE_NOT_FOUND');
  if (row.mode !== 'collect' || !row.verifiedAt || !row.legalName)
    throw new OperationError('NAME_NOT_LOCKED');
  // The name lock stays (verified, so only support changes it again), and our payment partner checks
  // the new name with the recipient's next bank details before anything more is transferred.
  await tx
    .update(profiles)
    .set({
      collectLegalName: storedName(parsed.data),
      collectNameRecheckAt: input.now,
    })
    .where(eq(profiles.id, input.profileId));
  await tellNameRecheck(tx, input);
  await recordAudit(tx, {
    staffUserId: input.staffUserId,
    action: 'collect_name.changed',
    permission: 'recoveries.manage',
    subjectType: 'profile',
    subjectId: input.profileId,
    reason: input.reason,
    now: input.now,
  });
  return { changed: true };
}
