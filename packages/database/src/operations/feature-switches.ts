import {
  FEATURE_SWITCHES,
  FEATURE_SWITCH_CATALOGUE,
  featureSwitchFromEnv,
  isFeatureSwitch,
  type FeatureSwitch,
  type FeatureSwitchSource,
  type OpsFeatureSwitch,
} from '@tipme/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  approvalRequests,
  featureSwitchChanges,
  featureSwitches,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { OperationError } from './errors.js';
import { newId } from './ids.js';
import { withAuditChange } from './staff.js';

/*
 * Feature switches (owner, 14 Nov 2026; docs/runbooks/settings-and-switches.md). Staff set them in
 * admin; each replaces an environment variable that now only seeds it on the first start.
 *
 * Reading: `featureOn(db, key)`, the one accessor for the API and the worker (the web app asks the
 * API). A process keeps every switch for FEATURE_SWITCH_CACHE_MS, so a change reaches it within that;
 * the process that made the change, and every API copy hearing the live channel, forgets at once.
 * Fail-safe: a failed read keeps the last value this process read, else the code default, which is
 * off for every money switch.
 */

export const FEATURE_SWITCH_CACHE_MS = 15_000;
/** After a failed read, how long the fallback stands before the next try, so an outage isn't a query per call. */
const FAILED_READ_RETRY_MS = 5_000;

type Values = Map<FeatureSwitch, boolean>;
type Reader = Pick<Database, 'select'>;

interface Kept {
  values: Values;
  at: number;
  generation: number;
}

/** Per database handle: the API and the worker each have their own (both in one test process). */
const kept = new WeakMap<object, Kept>();
const pending = new WeakMap<object, Promise<Values>>();
/** Bumped by every change this process makes or hears of; older reads are then stale. */
let generation = 0;
/**
 * This process's old variables, as read at start. Only for a switch with no row: before the first
 * start has written it, or after a test reset emptied the table. Production always has the rows.
 */
let seeds: Partial<Record<FeatureSwitch, boolean>> = {};
const errorListeners = new Set<(error: unknown) => void>();

/** Forget every switch read, in every handle of this process: the next read goes to the database. */
export function invalidateFeatureSwitches(): void {
  generation += 1;
}

/** Called with each failed read (for a log line). Returns a function that stops it. */
export function onFeatureSwitchReadError(
  listener: (error: unknown) => void,
): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

/** Tests only: forget the seeds and last reads, as a fresh process would. */
export function resetFeatureSwitchMemory(): void {
  seeds = {};
  invalidateFeatureSwitches();
}

const fallbackFor = (key: FeatureSwitch): boolean =>
  seeds[key] ?? FEATURE_SWITCH_CATALOGUE[key].default;

async function readAll(db: Reader): Promise<Values> {
  const rows = await db
    .select({ key: featureSwitches.key, enabled: featureSwitches.enabled })
    .from(featureSwitches);
  const values: Values = new Map();
  for (const row of rows)
    if (isFeatureSwitch(row.key)) values.set(row.key, row.enabled);
  return values;
}

/** Whether a switch is on in this process now. Never throws. */
export async function featureOn(
  db: Reader,
  key: FeatureSwitch,
  options: { now?: number } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const known = kept.get(db);
  if (
    known &&
    known.generation === generation &&
    now - known.at < FEATURE_SWITCH_CACHE_MS
  )
    return known.values.get(key) ?? fallbackFor(key);
  let read = pending.get(db);
  if (!read) {
    const startedAt = generation;
    read = (async () => {
      try {
        const values = await readAll(db);
        kept.set(db, { values, at: now, generation: startedAt });
        return values;
      } catch (error) {
        for (const listener of errorListeners) listener(error);
        // The last values this process read, kept as they were; none at all: the code defaults.
        const values =
          known?.values ??
          new Map<FeatureSwitch, boolean>(
            FEATURE_SWITCHES.map((k) => [
              k,
              FEATURE_SWITCH_CATALOGUE[k].default,
            ]),
          );
        kept.set(db, {
          values,
          at: now - FEATURE_SWITCH_CACHE_MS + FAILED_READ_RETRY_MS,
          generation: startedAt,
        });
        return values;
      } finally {
        pending.delete(db);
      }
    })();
    pending.set(db, read);
  }
  const values = await read;
  return values.get(key) ?? fallbackFor(key);
}

/** Uncached, inside a transaction: for a serious action deciding whether it may still run. */
export async function readFeatureSwitch(
  tx: Database | Tx,
  key: FeatureSwitch,
): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: featureSwitches.enabled })
    .from(featureSwitches)
    .where(eq(featureSwitches.key, key));
  return row?.enabled ?? fallbackFor(key);
}

/**
 * At each process's start: writes every switch that has no row yet, from its old variable when that
 * is set, else the code default, so nothing changes on release day. A switch that has a row keeps
 * it; its variable, if still set, is ignored and named in `ignored` (never its value) for a log line.
 * A malformed variable throws, naming it, as the config used to refuse it.
 */
export async function seedFeatureSwitches(
  db: Database,
  env: Record<string, string | undefined>,
  options: { now?: Date } = {},
): Promise<{
  written: { key: FeatureSwitch; source: 'env' | 'default' }[];
  ignored: string[];
}> {
  const now = options.now ?? new Date();
  const fromEnv = new Map<FeatureSwitch, boolean>();
  for (const key of FEATURE_SWITCHES) {
    const value = featureSwitchFromEnv(key, env);
    if (value !== undefined) fromEnv.set(key, value);
  }
  for (const [key, value] of fromEnv) seeds[key] = value;
  const written: { key: FeatureSwitch; source: 'env' | 'default' }[] = [];
  await db.transaction(async (tx) => {
    for (const key of FEATURE_SWITCHES) {
      const value = fromEnv.get(key);
      const source = value === undefined ? 'default' : 'env';
      const enabled = value ?? FEATURE_SWITCH_CATALOGUE[key].default;
      const reason =
        source === 'env'
          ? `Started from ${FEATURE_SWITCH_CATALOGUE[key].env.name} on the first start after release`
          : 'Started from the default on the first start after release';
      const [inserted] = await tx
        .insert(featureSwitches)
        .values({ key, enabled, source, changedAt: now, reason })
        .onConflictDoNothing()
        .returning({ key: featureSwitches.key });
      if (!inserted) continue;
      await tx.insert(featureSwitchChanges).values({
        id: newId(),
        key,
        enabled,
        source,
        reason,
        createdAt: now,
      });
      written.push({ key, source });
    }
  });
  const writtenKeys = new Set(written.map((w) => w.key));
  const ignored = [...fromEnv.keys()]
    .filter((key) => !writtenKeys.has(key))
    .map((key) => FEATURE_SWITCH_CATALOGUE[key].env.name);
  invalidateFeatureSwitches();
  return { written, ignored };
}

/**
 * Staff turn a switch on or off (inside a transaction: the serious action's, or the route's own). The
 * same value again is refused, so a waiting request that has been overtaken goes stale. Audited.
 */
export async function setFeatureSwitch(
  tx: Tx,
  input: {
    key: string;
    on: boolean;
    staffUserId: string;
    approvedBy: string | null;
    reason: string;
    now: Date;
  },
): Promise<{ key: FeatureSwitch; on: boolean; previous: boolean }> {
  if (!isFeatureSwitch(input.key) || typeof input.on !== 'boolean')
    throw new OperationError('INVALID_INPUT');
  const key = input.key;
  const [row] = await tx
    .select({ enabled: featureSwitches.enabled })
    .from(featureSwitches)
    .where(eq(featureSwitches.key, key))
    .for('update');
  const previous = row?.enabled ?? fallbackFor(key);
  if (previous === input.on) throw new OperationError('INVALID_INPUT');
  const values = {
    enabled: input.on,
    source: 'staff' as const,
    changedBy: input.staffUserId,
    changedAt: input.now,
    reason: input.reason,
  };
  await tx
    .insert(featureSwitches)
    .values({ key, ...values })
    .onConflictDoUpdate({ target: featureSwitches.key, set: values });
  await tx.insert(featureSwitchChanges).values({
    id: newId(),
    key,
    enabled: input.on,
    source: 'staff',
    changedBy: input.staffUserId,
    approvedBy: input.approvedBy,
    reason: input.reason,
    createdAt: input.now,
  });
  await recordAudit(tx, {
    staffUserId: input.staffUserId,
    action: 'feature_switch.set',
    permission: 'switches.manage',
    subjectType: 'feature_switch',
    subjectId: key,
    reason: withAuditChange(input.reason, {
      from: previous,
      to: input.on,
      approvedBy: input.approvedBy,
    }),
    now: input.now,
  });
  return { key, on: input.on, previous };
}

const HISTORY_LIMIT = 20;

/** Every switch for the admin screen: its state, who changed it last, its history. */
export async function featureSwitchOverview(
  db: Database,
): Promise<OpsFeatureSwitch[]> {
  const [rows, changes, waiting] = await Promise.all([
    db.select().from(featureSwitches),
    db
      .select()
      .from(featureSwitchChanges)
      .orderBy(desc(featureSwitchChanges.createdAt)),
    db
      .select({
        id: approvalRequests.id,
        payload: approvalRequests.payload,
      })
      .from(approvalRequests)
      .where(
        and(
          inArray(approvalRequests.action, ['feature_switch.set']),
          eq(approvalRequests.status, 'pending'),
        ),
      )
      .orderBy(desc(approvalRequests.createdAt)),
  ]);
  const stored = new Map(rows.map((row) => [row.key, row]));
  return FEATURE_SWITCHES.map((key) => {
    const entry = FEATURE_SWITCH_CATALOGUE[key];
    const row = stored.get(key);
    const request = waiting.find(
      (w) => (w.payload as { key?: unknown } | null)?.key === key,
    );
    return {
      key,
      label: entry.label,
      description: entry.description,
      money: entry.money,
      on: row?.enabled ?? fallbackFor(key),
      default: entry.default,
      envName: entry.env.name,
      source: (row?.source as FeatureSwitchSource | undefined) ?? null,
      changedBy: row?.changedBy ?? null,
      changedAt: row?.changedAt.toISOString() ?? null,
      reason: row?.reason ?? null,
      waitingRequestId: request?.id ?? null,
      history: changes
        .filter((change) => change.key === key)
        .slice(0, HISTORY_LIMIT)
        .map((change) => ({
          id: change.id,
          on: change.enabled,
          source: change.source as FeatureSwitchSource,
          changedBy: change.changedBy,
          approvedBy: change.approvedBy,
          reason: change.reason,
          createdAt: change.createdAt.toISOString(),
        })),
    };
  });
}
