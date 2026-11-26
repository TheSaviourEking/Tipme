import {
  currentRuleOfKey,
  FEE_WAIVER_FEES,
  FEE_WAIVER_KINDS,
  FEE_WAIVER_PAYERS,
  feeWaiverShapeProblem,
  feeWaiverWindow,
  lagosDayStart,
  resolveFeeWaiver,
  type FeeWaiverFee,
  type FeeWaiverKind,
  type FeeWaiverPayer,
  type FeeWaiverResolution,
  type FeeWaiverRule,
} from '@tipme/domain';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  businesses,
  feeWaivers,
  paymentIntents,
  payouts,
  profiles,
  tipQuotes,
  tips,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { OperationError } from './errors.js';
import { newId } from './ids.js';
import type { MoneyOwner } from './owner.js';
import { withAuditChange } from './staff.js';

/*
 * Fee waivers (spec 2026-11-23 §4): reading the append-only rule table. The pure rules (which row
 * of a key is in force, account over kind) are in @tipme/domain; this file only fetches the rows.
 * Writing a rule is the serious action `fee_waiver.set` (Task 3): `setFeeWaiver` below.
 */

/** A stored rule, with who set it and why. */
export interface FeeWaiverRow extends FeeWaiverRule {
  reason: string;
  setBy: string | null;
  approvedBy: string | null;
}

/** One key of the table (W2): a kind-wide rule, or one account's rule, for one fee. */
export type FeeWaiverKey =
  | { scope: 'kind'; kind: FeeWaiverKind; fee: FeeWaiverFee }
  | {
      scope: 'account';
      kind: FeeWaiverKind;
      owner: MoneyOwner;
      fee: FeeWaiverFee;
    };

type Stored = typeof feeWaivers.$inferSelect;

function toRow(r: Stored): FeeWaiverRow {
  return {
    id: r.id,
    scope: r.scope as FeeWaiverRow['scope'],
    kind: r.kind as FeeWaiverKind,
    accountId: r.profileId ?? r.businessId,
    fee: r.fee as FeeWaiverFee,
    payer: r.payer as FeeWaiverRow['payer'],
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    createdAt: r.createdAt,
    reason: r.reason,
    setBy: r.setBy,
    approvedBy: r.approvedBy,
  };
}

/** A person's page follows `individual` rules, a business's balance `business` ones (W5). */
const kindOf = (owner: MoneyOwner): FeeWaiverKind =>
  'businessId' in owner ? 'business' : 'individual';

const ownerIs = (owner: MoneyOwner): SQL =>
  'businessId' in owner
    ? eq(feeWaivers.businessId, owner.businessId)
    : eq(feeWaivers.profileId, owner.profileId);

function keyIs(key: FeeWaiverKey): SQL {
  const common = and(
    eq(feeWaivers.scope, key.scope),
    eq(feeWaivers.kind, key.kind),
    eq(feeWaivers.fee, key.fee),
  )!;
  return key.scope === 'kind'
    ? and(common, isNull(feeWaivers.profileId), isNull(feeWaivers.businessId))!
    : and(common, ownerIs(key.owner))!;
}

const newestFirst = [desc(feeWaivers.startsAt), desc(feeWaivers.createdAt)];

/**
 * The newest row of a key that has started by `now`, if any: the only row that can be in force
 * (W2). Older rows are history and never read here.
 */
async function latestStarted(
  db: Database | Tx,
  key: FeeWaiverKey,
  now: Date,
): Promise<FeeWaiverRow[]> {
  const rows = await db
    .select()
    .from(feeWaivers)
    .where(and(keyIs(key), lte(feeWaivers.startsAt, now)))
    .orderBy(...newestFirst)
    .limit(1);
  return rows.map(toRow);
}

/**
 * Who pays `fee` for `owner` at `now` (§4): the account's rule, else its kind's rule, else today's
 * default. Reads one row per key, so the cost does not grow with the history.
 */
export async function feeWaiverFor(
  db: Database | Tx,
  input: { owner: MoneyOwner; fee: FeeWaiverFee; now: Date },
): Promise<FeeWaiverResolution> {
  const kind = kindOf(input.owner);
  // One after the other: a transaction is one connection.
  const accountRows = await latestStarted(
    db,
    { scope: 'account', kind, owner: input.owner, fee: input.fee },
    input.now,
  );
  const kindRows = await latestStarted(
    db,
    { scope: 'kind', kind, fee: input.fee },
    input.now,
  );
  return resolveFeeWaiver({ accountRows, kindRows, now: input.now });
}

/**
 * The rules staff see (§8): each key's row in force at `now` (whatever its payer), and the rows not
 * started yet, soonest first. `filter.kind` keeps one kind's rules (kind-wide and account);
 * `filter.owner` keeps that one account's own rules.
 */
export async function feeWaiverRules(
  db: Database | Tx,
  input: {
    now: Date;
    filter?: { kind?: FeeWaiverKind; owner?: MoneyOwner };
  },
): Promise<{ inForce: FeeWaiverRow[]; upcoming: FeeWaiverRow[] }> {
  const { now, filter = {} } = input;
  const scoped: SQL[] = [];
  if (filter.kind !== undefined) scoped.push(eq(feeWaivers.kind, filter.kind));
  if (filter.owner !== undefined) scoped.push(ownerIs(filter.owner));
  // The newest started row of each key; currentRuleOfKey then drops a key whose row has ended.
  const latest = await db
    .selectDistinctOn([
      feeWaivers.scope,
      feeWaivers.kind,
      feeWaivers.profileId,
      feeWaivers.businessId,
      feeWaivers.fee,
    ])
    .from(feeWaivers)
    .where(and(lte(feeWaivers.startsAt, now), ...scoped))
    .orderBy(
      feeWaivers.scope,
      feeWaivers.kind,
      feeWaivers.profileId,
      feeWaivers.businessId,
      feeWaivers.fee,
      ...newestFirst,
    );
  const inForce = latest
    .map(toRow)
    .filter((row) => currentRuleOfKey([row], now) !== null)
    .sort(
      (a, b) =>
        b.startsAt.getTime() - a.startsAt.getTime() ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
  const upcoming = await db
    .select()
    .from(feeWaivers)
    .where(and(gt(feeWaivers.startsAt, now), ...scoped))
    .orderBy(asc(feeWaivers.startsAt), asc(feeWaivers.createdAt));
  return { inForce, upcoming: upcoming.map(toRow) };
}

/**
 * The newest row of a key by `starts_at` (ties: latest `created_at`), upcoming included: what a
 * waiting `fee_waiver.set` request pins, so any change to the key makes it stale (W10).
 */
export async function latestRowOfKey(
  db: Database | Tx,
  key: FeeWaiverKey,
): Promise<FeeWaiverRow | null> {
  const [row] = await db
    .select()
    .from(feeWaivers)
    .where(keyIs(key))
    .orderBy(...newestFirst)
    .limit(1);
  return row ? toRow(row) : null;
}

/* Setting a rule: the serious action `fee_waiver.set` (plan Task 3) */

export const FEE_WAIVER_SET_ACTION = 'fee_waiver.set';

/** What staff ask for. The instants are ISO strings; the action decides the real start (W3). */
export type FeeWaiverSetPayload = {
  scope: 'kind' | 'account';
  kind: FeeWaiverKind;
  profileId?: string;
  businessId?: string;
  fee: FeeWaiverFee;
  payer: FeeWaiverPayer;
  startsAt?: string;
  endsAt?: string;
  /** The explicit confirm of the estimated monthly cost, for a kind-wide TipMe-pays rule (W11). */
  confirmCost?: true;
  /**
   * The estimate confirmed, in minor units as a digit string: what the approver reads, fixed when
   * asked so the words don't move while the request waits. It must be the live figure when asked.
   */
  costEstimateMinor?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const PAYLOAD_KEYS = new Set([
  'scope',
  'kind',
  'profileId',
  'businessId',
  'fee',
  'payer',
  'startsAt',
  'endsAt',
  'confirmCost',
  'costEstimateMinor',
]);

const oneOf = <T extends string>(
  list: readonly T[],
  value: unknown,
): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

function instant(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ISO_INSTANT.test(value))
    throw new OperationError('INVALID_INPUT');
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new OperationError('INVALID_INPUT');
  return new Date(ms).toISOString();
}

/**
 * Parses the serious action's payload (W1, W5): known fields only, an allowed shape, the account
 * id that matches the kind (a page for `individual`, a business for `business`), and ISO instants,
 * returned in UTC. Throws INVALID_INPUT.
 */
export function checkedFeeWaiverPayload(p: unknown): FeeWaiverSetPayload {
  if (typeof p !== 'object' || p === null || Array.isArray(p))
    throw new OperationError('INVALID_INPUT');
  const raw = p as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !PAYLOAD_KEYS.has(key)))
    throw new OperationError('INVALID_INPUT');
  const {
    scope,
    kind,
    fee,
    payer,
    profileId,
    businessId,
    confirmCost,
    costEstimateMinor,
  } = raw;
  if (
    !oneOf(['kind', 'account'] as const, scope) ||
    !oneOf(FEE_WAIVER_KINDS, kind) ||
    !oneOf(FEE_WAIVER_FEES, fee) ||
    !oneOf(FEE_WAIVER_PAYERS, payer)
  )
    throw new OperationError('INVALID_INPUT');
  const id = (value: unknown) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !UUID.test(value))
      throw new OperationError('INVALID_INPUT');
    return value.toLowerCase();
  };
  const page = id(profileId);
  const business = id(businessId);
  const problem = feeWaiverShapeProblem({
    scope,
    kind,
    fee,
    payer,
    hasAccount: page !== undefined || business !== undefined,
  });
  if (problem !== null) throw new OperationError('INVALID_INPUT', problem);
  // The account's id names its kind: a page is an individual, a business a business (W1).
  if (
    scope === 'account' &&
    !(kind === 'individual'
      ? page !== undefined && business === undefined
      : business !== undefined && page === undefined)
  )
    throw new OperationError('INVALID_INPUT');
  if (confirmCost !== undefined && confirmCost !== true)
    throw new OperationError('INVALID_INPUT');
  // A figure is only ever confirmed, and only where it is checked (a kind-wide TipMe-pays rule), so
  // no unchecked figure reaches the words or the audit.
  if (
    costEstimateMinor !== undefined &&
    (confirmCost !== true ||
      scope !== 'kind' ||
      payer !== 'tipme' ||
      typeof costEstimateMinor !== 'string' ||
      !/^(0|[1-9][0-9]{0,15})$/.test(costEstimateMinor))
  )
    throw new OperationError('INVALID_INPUT');
  const startsAt = instant(raw.startsAt);
  const endsAt = instant(raw.endsAt);
  return {
    scope,
    kind,
    ...(page === undefined ? {} : { profileId: page }),
    ...(business === undefined ? {} : { businessId: business }),
    fee,
    payer,
    ...(startsAt === undefined ? {} : { startsAt }),
    ...(endsAt === undefined ? {} : { endsAt }),
    ...(confirmCost === true ? { confirmCost } : {}),
    ...(typeof costEstimateMinor === 'string' ? { costEstimateMinor } : {}),
  };
}

/** The key a checked payload writes to (W2). */
export function feeWaiverKeyOf(payload: FeeWaiverSetPayload): FeeWaiverKey {
  if (payload.scope === 'kind')
    return { scope: 'kind', kind: payload.kind, fee: payload.fee };
  const owner: MoneyOwner =
    payload.businessId !== undefined
      ? { businessId: payload.businessId }
      : { profileId: payload.profileId! };
  return { scope: 'account', kind: payload.kind, owner, fee: payload.fee };
}

/**
 * The serious action's target and the advisory lock's text: `fee_waiver:<scope>:<kind>:<id|*>:<fee>`.
 * One per key, so two requests for the same key are one target (W10).
 */
export function feeWaiverTarget(payload: FeeWaiverSetPayload): string {
  const account = payload.profileId ?? payload.businessId ?? '*';
  return `fee_waiver:${payload.scope}:${payload.kind}:${account}:${payload.fee}`;
}

/** Whether a kind-wide rule makes TipMe pay: the one shape that needs its cost confirmed (W11). */
export const feeWaiverNeedsCostConfirm = (
  payload: FeeWaiverSetPayload,
): boolean => payload.scope === 'kind' && payload.payer === 'tipme';

/** Refuses a kind-wide TipMe-pays rule whose estimated cost was not explicitly confirmed, figure and all. */
export function requireFeeWaiverConfirm(payload: FeeWaiverSetPayload): void {
  if (
    feeWaiverNeedsCostConfirm(payload) &&
    (payload.confirmCost !== true || payload.costEstimateMinor === undefined)
  )
    throw new OperationError('FEE_WAIVER_CONFIRM_REQUIRED');
}

const ESTIMATE_MOVED = 'estimate_moved:';

/**
 * When asked (not on approval): the figure confirmed must be the live estimate, so nobody asks on a
 * figure they didn't see. The estimate only moves at Lagos midnight, so this refuses only across it:
 * FEE_WAIVER_CONFIRM_REQUIRED, carrying the new figure (`currentEstimateOf`) to confirm instead.
 */
export async function requireFeeWaiverEstimateCurrent(
  db: Database | Tx,
  payload: FeeWaiverSetPayload,
  now: Date,
): Promise<void> {
  requireFeeWaiverConfirm(payload);
  if (!feeWaiverNeedsCostConfirm(payload)) return;
  const live = await estimateFeeWaiverMonthlyCost(db, {
    kind: payload.kind,
    fee: payload.fee,
    now,
  });
  if (BigInt(payload.costEstimateMinor!) !== live)
    throw new OperationError(
      'FEE_WAIVER_CONFIRM_REQUIRED',
      `${ESTIMATE_MOVED}${live}`,
    );
}

/** The live estimate an `estimate_moved` refusal carries, for the screen to show; else null. */
export function currentEstimateOf(error: unknown): bigint | null {
  if (
    !(error instanceof OperationError) ||
    error.code !== 'FEE_WAIVER_CONFIRM_REQUIRED' ||
    !error.detail?.startsWith(ESTIMATE_MOVED)
  )
    return null;
  const digits = error.detail.slice(ESTIMATE_MOVED.length);
  return /^(0|[1-9][0-9]*)$/.test(digits) ? BigInt(digits) : null;
}

const ESTIMATE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * What a kind-wide TipMe-pays rule would have cost over the last 30 days (W11), counted over whole
 * Lagos days: the 30 days before today's start in Lagos, so the figure holds all day and a screen's
 * figure is still the live one when the code is entered. For the tip fee, the
 * fees (platform + provider) of SUCCEEDED tips completed then; for the withdrawal fee, the user fees
 * of that kind's non-FAILED withdrawals asked for then. Giving is 0 until it is built. Team tips
 * count too: their fee is charged like a person's tip. A withdrawal TipMe already covered counts
 * the fee it would have charged (`waived_fee_minor`) instead of its user fee, which is then 0 (W8),
 * so each payout counts once and renewing a waiver doesn't read as free.
 */
export async function estimateFeeWaiverMonthlyCost(
  db: Database | Tx,
  input: { kind: FeeWaiverKind; fee: FeeWaiverFee; now: Date },
): Promise<bigint> {
  const { kind, fee, now } = input;
  const until = lagosDayStart(now);
  const since = new Date(until.getTime() - ESTIMATE_DAYS * DAY_MS);
  if (kind === 'giving') return 0n;
  if (fee === 'tip') {
    if (kind !== 'individual') return 0n;
    const [row] = await db
      .select({
        total: sql<string>`coalesce(sum(${tipQuotes.platformFeeMinor} + ${tipQuotes.providerFeeMinor}), 0)::text`,
      })
      .from(tips)
      .innerJoin(paymentIntents, eq(paymentIntents.id, tips.intentId))
      .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
      .where(
        and(
          eq(tips.status, 'SUCCEEDED'),
          gte(tips.completedAt, since),
          lt(tips.completedAt, until),
        ),
      );
    return BigInt(row?.total ?? '0');
  }
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(CASE WHEN ${payouts.feeWaiverId} IS NOT NULL
        THEN ${payouts.waivedFeeMinor} ELSE ${payouts.userFeeMinor} END), 0)::text`,
    })
    .from(payouts)
    .where(
      and(
        ne(payouts.status, 'FAILED'),
        kind === 'business'
          ? isNotNull(payouts.businessId)
          : isNotNull(payouts.profileId),
        gte(payouts.createdAt, since),
        lt(payouts.createdAt, until),
      ),
    );
  return BigInt(row?.total ?? '0');
}

const sameInstant = (a: Date | null, b: Date | null) =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

/**
 * Whether a new row would change nothing: the key's latest row already has this payer and end and
 * has started by then, or the key has no rule (none, or the latest has ended) and this only ends it
 * (`inherit` on an account, `account` on a kind). Refused, so an overtaken request goes stale.
 */
function changesNothing(
  current: FeeWaiverRow | null,
  payload: FeeWaiverSetPayload,
  window: { startsAt: Date; endsAt: Date | null },
): boolean {
  const ends =
    payload.payer === (payload.scope === 'account' ? 'inherit' : 'account');
  const idle =
    current === null ||
    (current.endsAt !== null &&
      current.endsAt.getTime() <= window.startsAt.getTime());
  if (idle) return ends;
  return (
    current.payer === payload.payer &&
    sameInstant(current.endsAt, window.endsAt) &&
    current.startsAt.getTime() <= window.startsAt.getTime()
  );
}

const iso = (at: Date | null) => (at === null ? null : at.toISOString());

/**
 * Stores a new rule for one key. Runs inside the serious action, so `approvedBy` is the second person
 * (or null when a lone admin acted alone, with the acted-alone alert). Under the key's advisory lock
 * (W10) it fixes the dates at act time (W3: never retroactive; W4: bounds), checks the account, the
 * cost confirm (W11) and that something changes, then appends the row and audits from, to and
 * approver. Ending a waiver now is `payer: 'inherit'` (account) or `'account'` (kind) with no end.
 */
export async function setFeeWaiver(
  tx: Tx,
  input: FeeWaiverSetPayload & {
    staffUserId: string;
    approvedBy: string | null;
    reason: string;
    now: Date;
  },
): Promise<{ id: string; startsAt: Date; endsAt: Date | null }> {
  const { staffUserId, approvedBy, reason, now, ...rest } = input;
  const payload = checkedFeeWaiverPayload(rest);
  const target = feeWaiverTarget(payload);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${target}))`);
  const window = feeWaiverWindow({
    requestedStart:
      payload.startsAt === undefined ? null : new Date(payload.startsAt),
    endsAt: payload.endsAt === undefined ? null : new Date(payload.endsAt),
    now,
  });
  if (typeof window === 'string')
    throw new OperationError(
      'INVALID_INPUT',
      `The ${window} is out of bounds.`,
    );
  if (payload.profileId !== undefined) {
    const [page] = await tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, payload.profileId));
    if (!page) throw new OperationError('PROFILE_NOT_FOUND');
  }
  if (payload.businessId !== undefined) {
    const [business] = await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, payload.businessId));
    if (!business) throw new OperationError('BUSINESS_NOT_FOUND');
  }
  requireFeeWaiverConfirm(payload);
  const current = await latestRowOfKey(tx, feeWaiverKeyOf(payload));
  if (changesNothing(current, payload, window))
    throw new OperationError('INVALID_INPUT', 'That changes nothing.');
  const id = newId();
  await tx.insert(feeWaivers).values({
    id,
    scope: payload.scope,
    kind: payload.kind,
    profileId: payload.profileId ?? null,
    businessId: payload.businessId ?? null,
    fee: payload.fee,
    payer: payload.payer,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    reason,
    setBy: staffUserId,
    approvedBy,
    createdAt: now,
  });
  await recordAudit(tx, {
    staffUserId,
    action: FEE_WAIVER_SET_ACTION,
    permission: 'fees.manage',
    subjectType: 'fee_waiver',
    subjectId: id,
    reason: withAuditChange(reason, {
      key: target,
      from: current
        ? {
            id: current.id,
            payer: current.payer,
            startsAt: iso(current.startsAt),
            endsAt: iso(current.endsAt),
          }
        : null,
      to: {
        payer: payload.payer,
        startsAt: iso(window.startsAt),
        endsAt: iso(window.endsAt),
      },
      ...(payload.costEstimateMinor === undefined
        ? {}
        : { costEstimateMinor: payload.costEstimateMinor }),
      approvedBy,
    }),
    now,
  });
  return { id, startsAt: window.startsAt, endsAt: window.endsAt };
}
