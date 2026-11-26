import { DEFAULT_CARD_COST, type CardCost } from '@tipme/domain';
import { and, desc, eq, lte } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { approvalRequests, cardCostSettings } from '../schema.js';
import { recordAudit } from './audit.js';
import { OperationError } from './errors.js';
import { newId } from './ids.js';
import { percentOf } from './plan-fee-rates.js';
import { withAuditChange } from './staff.js';

/*
 * What a card payment costs TipMe (owner, 26 Nov 2026: an ops screen, not env settings), as the plan
 * fee rates (plan-fee-rates.ts): append-only history, the latest row whose `effective_from` has
 * passed is in force, coded defaults when none is stored (2% + ₦45, margin ₦15). A change is the
 * serious action `card_costs.change` (a second person approves, or a lone admin acts alone with the
 * alert), audited with from, to and approver. Card is offered on a tip only when TipMe's share
 * covers this cost (profit guards, Part 2).
 */

export const CARD_COSTS_CHANGE_ACTION = 'card_costs.change';

export interface CardCostRow {
  id: string;
  rateBps: number;
  fixedMinor: bigint;
  marginMinor: bigint;
  effectiveFrom: Date;
  setBy: string | null;
  approvedBy: string | null;
  reason: string;
  createdAt: Date;
}

/** The latest stored card cost whose `effective_from` is at or before `at`; null when none. */
export async function cardCostRowAt(
  db: Database | Tx,
  at: Date,
): Promise<CardCostRow | null> {
  const [row] = await db
    .select()
    .from(cardCostSettings)
    .where(lte(cardCostSettings.effectiveFrom, at))
    .orderBy(
      desc(cardCostSettings.effectiveFrom),
      desc(cardCostSettings.createdAt),
    )
    .limit(1);
  return row ?? null;
}

const costOf = (row: CardCostRow): CardCost => ({
  rateBps: BigInt(row.rateBps),
  fixedMinor: row.fixedMinor,
  marginMinor: row.marginMinor,
});

/**
 * The card cost in force at `at`: the latest row with `effective_from` ≤ `at`, or the coded
 * defaults when none is stored. A database error throws (never a silent default).
 */
export async function cardCostAt(
  db: Database | Tx,
  at: Date,
): Promise<CardCost> {
  const row = await cardCostRowAt(db, at);
  return row ? costOf(row) : { ...DEFAULT_CARD_COST };
}

/** Every stored card cost, newest first, for staff. */
export function cardCostHistory(
  db: Database | Tx,
  limit: number,
): Promise<CardCostRow[]> {
  return db
    .select()
    .from(cardCostSettings)
    .orderBy(
      desc(cardCostSettings.effectiveFrom),
      desc(cardCostSettings.createdAt),
    )
    .limit(limit);
}

/** Refuses a cost the table would refuse: a rate outside 0 to 10000 bps, a negative amount. */
function checkedCost(cost: CardCost): CardCost {
  if (
    cost.rateBps < 0n ||
    cost.rateBps > 10000n ||
    cost.fixedMinor < 0n ||
    cost.marginMinor < 0n
  )
    throw new OperationError('INVALID_INPUT');
  return cost;
}

/**
 * Parses the serious action's payload: the rate as a whole number of basis points, the amounts as
 * kobo in strings of digits (the contract's shapes).
 */
export function checkedCardCostPayload(payload: {
  rateBps: unknown;
  fixedMinor: unknown;
  marginMinor: unknown;
}): CardCost {
  const digits = (value: unknown) =>
    typeof value === 'string' && /^(0|[1-9][0-9]{0,11})$/.test(value);
  if (
    typeof payload.rateBps !== 'number' ||
    !Number.isInteger(payload.rateBps) ||
    !digits(payload.fixedMinor) ||
    !digits(payload.marginMinor)
  )
    throw new OperationError('INVALID_INPUT');
  return checkedCost({
    rateBps: BigInt(payload.rateBps),
    fixedMinor: BigInt(payload.fixedMinor as string),
    marginMinor: BigInt(payload.marginMinor as string),
  });
}

/** The cost as the audit record and the request pin write it: every field a string. */
export const cardCostRecord = (cost: CardCost) => ({
  rateBps: String(cost.rateBps),
  fixedMinor: String(cost.fixedMinor),
  marginMinor: String(cost.marginMinor),
});

/** Kobo as staff read it in summaries: ₦45, or ₦45.50 when there are kobo. */
const nairaWords = (minor: bigint): string => {
  const kobo = minor % 100n;
  return `₦${(minor / 100n).toLocaleString('en-NG')}${kobo ? `.${String(kobo).padStart(2, '0')}` : ''}`;
};

/** "2% + ₦45, margin ₦15": a card cost as the approval summary says it. */
export const cardCostWords = (cost: CardCost): string =>
  `${percentOf(cost.rateBps)} + ${nairaWords(cost.fixedMinor)}, margin ${nairaWords(cost.marginMinor)}`;

const sameCost = (a: CardCost, b: CardCost) =>
  a.rateBps === b.rateBps &&
  a.fixedMinor === b.fixedMinor &&
  a.marginMinor === b.marginMinor;

/**
 * Stores a new card cost from `now`. Runs inside the serious action, so `approvedBy` is the second
 * person (or null when a lone admin acted alone, with the acted-alone alert). Refuses a cost out of
 * bounds or the one already in force.
 */
export async function setCardCosts(
  tx: Tx,
  input: {
    cost: CardCost;
    actorId: string;
    approvedBy: string | null;
    reason: string;
    now: Date;
  },
): Promise<void> {
  const cost = checkedCost(input.cost);
  const previous = await cardCostAt(tx, input.now);
  if (sameCost(previous, cost)) throw new OperationError('INVALID_INPUT');
  const id = newId();
  await tx.insert(cardCostSettings).values({
    id,
    rateBps: Number(cost.rateBps),
    fixedMinor: cost.fixedMinor,
    marginMinor: cost.marginMinor,
    effectiveFrom: input.now,
    setBy: input.actorId,
    approvedBy: input.approvedBy,
    reason: input.reason,
    createdAt: input.now,
  });
  await recordAudit(tx, {
    staffUserId: input.actorId,
    action: 'card_costs.changed',
    permission: 'fees.manage',
    subjectType: 'card_cost_settings',
    subjectId: id,
    reason: withAuditChange(input.reason, {
      from: cardCostRecord(previous),
      to: cardCostRecord(cost),
      approvedBy: input.approvedBy,
    }),
    now: input.now,
  });
}

/** A card cost change still waiting for a second person, so the screen says so. */
export async function waitingCardCostsRequest(
  db: Database | Tx,
): Promise<string | null> {
  const [row] = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.action, CARD_COSTS_CHANGE_ACTION),
        eq(approvalRequests.status, 'pending'),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1);
  return row?.id ?? null;
}
