import {
  currentRuleOfKey,
  resolveFeeWaiver,
  type FeeWaiverFee,
  type FeeWaiverKind,
  type FeeWaiverResolution,
  type FeeWaiverRule,
} from '@tipme/domain';
import { and, asc, desc, eq, gt, isNull, lte, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { feeWaivers } from '../schema.js';
import type { MoneyOwner } from './owner.js';

/*
 * Fee waivers (spec 2026-11-23 §4): reading the append-only rule table. The pure rules (which row
 * of a key is in force, account over kind) are in @tipme/domain; this file only fetches the rows.
 * Writing a rule is the serious action `fee_waiver.set` (Task 3).
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
