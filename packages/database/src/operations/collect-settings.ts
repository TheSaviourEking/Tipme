import { withdrawalMinimumMinor } from '@tipme/domain';
import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { approvalRequests, collectSettings } from '../schema.js';
import { recordAudit } from './audit.js';
import { OperationError } from './errors.js';
import { newId } from './ids.js';
import { withAuditChange } from './staff.js';

/*
 * You collect's settings (spec §9; ADR-0016, PROPOSED), read like the plan fee rates
 * (plan-fee-rates.ts): append-only history, the latest row whose `effective_from` has passed is in
 * force, and the coded defaults when none is stored. Read when used, never cached, so a change applies
 * at once. Changing them is the serious action `collect_settings.change` (Task 12, below), audited,
 * with the owners alerted as for the plan fee rates; staff's pause of every collect transfer is
 * `collect_transfers.pause` and `collect_transfers.resume` (R11), a new row each time.
 */

export interface CollectSettings {
  /** The most TipMe holds for one recipient who hasn't added bank details (kobo). */
  capMinor: bigint;
  /** How long it holds it, in days. */
  capDays: number;
  /** The days after the first tip on which the recipient is reminded, each below `capDays`. */
  reminderDays: number[];
  /** The new-recipient delay: a share is sent this many hours after the tip settles... */
  delayHours: number;
  /** ...for this many days after the recipient signs up. */
  delayForDays: number;
  /** The most a new account can withdraw the first time (kobo). */
  firstWithdrawalCapMinor: bigint;
  /** The most a new account can withdraw in a Lagos day (kobo)... */
  newDailyLimitMinor: bigint;
  /** ...for this many days after it signs up (spec §8 "for the first 30 days"; plan Task 12). */
  newDailyLimitDays: number;
  /** TipMe's own money above what it holds for recipients: alert levels (kobo). */
  reserveWarningMinor: bigint;
  reserveCriticalMinor: bigint;
  /** Staff paused every collect transfer (ruling R11). */
  paused: boolean;
}

/** The spec's defaults (§9), in force while no setting is stored. */
export const COLLECT_DEFAULTS: Readonly<CollectSettings> = Object.freeze({
  capMinor: 5_000_000n,
  capDays: 30,
  reminderDays: Object.freeze([7, 21, 28]) as number[],
  delayHours: 24,
  delayForDays: 7,
  firstWithdrawalCapMinor: 5_000_000n,
  newDailyLimitMinor: 20_000_000n,
  newDailyLimitDays: 30,
  reserveWarningMinor: 50_000_000n,
  reserveCriticalMinor: 25_000_000n,
  paused: false,
});

export interface CollectSettingsInForce extends CollectSettings {
  /** `setting` when a stored row is in force, `default` for the coded defaults. */
  source: 'setting' | 'default';
  /** The stored row in force, if any. */
  rowId: string | null;
}

/**
 * The settings in force now: the latest stored row whose `effective_from` has passed, or
 * `COLLECT_DEFAULTS`. The table's checks keep a stored row in the spec's bounds.
 */
export async function collectSettingsInForce(
  db: Database | Tx,
  now: Date = new Date(),
): Promise<CollectSettingsInForce> {
  const [row] = await db
    .select()
    .from(collectSettings)
    .where(lte(collectSettings.effectiveFrom, now))
    .orderBy(
      desc(collectSettings.effectiveFrom),
      desc(collectSettings.createdAt),
    )
    .limit(1);
  if (!row)
    return {
      ...COLLECT_DEFAULTS,
      reminderDays: [...COLLECT_DEFAULTS.reminderDays],
      source: 'default',
      rowId: null,
    };
  return {
    capMinor: row.capMinor,
    capDays: row.capDays,
    reminderDays: [...row.reminderDays],
    delayHours: row.delayHours,
    delayForDays: row.delayForDays,
    firstWithdrawalCapMinor: row.firstWithdrawalCapMinor,
    newDailyLimitMinor: row.newDailyLimitMinor,
    newDailyLimitDays: row.newDailyLimitDays,
    reserveWarningMinor: row.reserveWarningMinor,
    reserveCriticalMinor: row.reserveCriticalMinor,
    paused: row.paused,
    source: 'setting',
    rowId: row.id,
  };
}

export const COLLECT_SETTINGS_CHANGE_ACTION = 'collect_settings.change';
export const COLLECT_TRANSFERS_PAUSE_ACTION = 'collect_transfers.pause';
export const COLLECT_TRANSFERS_RESUME_ACTION = 'collect_transfers.resume';

/** The settings a change sets: everything but staff's pause, which has its own actions. */
export type CollectSettingValues = Omit<CollectSettings, 'paused'>;

const SETTING_KEYS = [
  'capMinor',
  'capDays',
  'reminderDays',
  'delayHours',
  'delayForDays',
  'firstWithdrawalCapMinor',
  'newDailyLimitMinor',
  'newDailyLimitDays',
  'reserveWarningMinor',
  'reserveCriticalMinor',
] as const satisfies readonly (keyof CollectSettingValues)[];

/** The settings as a serious action's payload and an audit record carry them: amounts as digits. */
export type CollectSettingsPayload = {
  [K in keyof CollectSettingValues]: CollectSettingValues[K] extends bigint
    ? string
    : CollectSettingValues[K];
};

export function collectSettingsPayload(
  values: CollectSettingValues,
): CollectSettingsPayload {
  return {
    capMinor: String(values.capMinor),
    capDays: values.capDays,
    reminderDays: [...values.reminderDays],
    delayHours: values.delayHours,
    delayForDays: values.delayForDays,
    firstWithdrawalCapMinor: String(values.firstWithdrawalCapMinor),
    newDailyLimitMinor: String(values.newDailyLimitMinor),
    newDailyLimitDays: values.newDailyLimitDays,
    reserveWarningMinor: String(values.reserveWarningMinor),
    reserveCriticalMinor: String(values.reserveCriticalMinor),
  };
}

const between = (value: unknown, low: number, high: number): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= low &&
  value <= high;
const amount = (value: unknown): bigint | null =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,11})$/.test(value)
    ? BigInt(value)
    : null;

/**
 * Parses and checks a change's payload (spec §9, plan Task 12). Beyond the table's bounds: critical
 * below warning, every reminder day from 1 to the day before the cap's last, the first-withdrawal cap
 * and the daily limit each at least the minimum withdrawal (the fee policy's, read here, never a
 * number of our own), so a new account can always withdraw something. Reminder days are
 * de-duplicated and sorted. Anything else refuses `INVALID_INPUT`.
 */
export function checkedCollectSettings(payload: unknown): CollectSettingValues {
  if (typeof payload !== 'object' || payload === null)
    throw new OperationError('INVALID_INPUT');
  const p = payload as Record<string, unknown>;
  const capMinor = amount(p.capMinor);
  const firstWithdrawalCapMinor = amount(p.firstWithdrawalCapMinor);
  const newDailyLimitMinor = amount(p.newDailyLimitMinor);
  const reserveWarningMinor = amount(p.reserveWarningMinor);
  const reserveCriticalMinor = amount(p.reserveCriticalMinor);
  const minimum = withdrawalMinimumMinor();
  if (
    capMinor === null ||
    capMinor < 1_000_000n ||
    capMinor > 50_000_000n ||
    !between(p.capDays, 7, 90) ||
    !between(p.delayHours, 0, 72) ||
    !between(p.delayForDays, 0, 30) ||
    !between(p.newDailyLimitDays, 0, 365) ||
    firstWithdrawalCapMinor === null ||
    firstWithdrawalCapMinor < minimum ||
    newDailyLimitMinor === null ||
    newDailyLimitMinor < minimum ||
    reserveWarningMinor === null ||
    reserveCriticalMinor === null ||
    reserveCriticalMinor >= reserveWarningMinor ||
    !Array.isArray(p.reminderDays)
  )
    throw new OperationError('INVALID_INPUT');
  const capDays = p.capDays;
  const raw: unknown[] = p.reminderDays;
  if (
    raw.length === 0 ||
    raw.length > 10 ||
    !raw.every((day) => between(day, 1, capDays - 1))
  )
    throw new OperationError('INVALID_INPUT');
  const reminderDays = [...new Set(raw as number[])].sort((a, b) => a - b);
  return {
    capMinor,
    capDays,
    reminderDays,
    delayHours: p.delayHours as number,
    delayForDays: p.delayForDays as number,
    firstWithdrawalCapMinor,
    newDailyLimitMinor,
    newDailyLimitDays: p.newDailyLimitDays as number,
    reserveWarningMinor,
    reserveCriticalMinor,
  };
}

const sameSettings = (a: CollectSettingValues, b: CollectSettingValues) =>
  JSON.stringify(collectSettingsPayload(a)) ===
  JSON.stringify(collectSettingsPayload(b));

const valuesOf = (settings: CollectSettings): CollectSettingValues =>
  Object.fromEntries(
    SETTING_KEYS.map((key) => [key, settings[key]]),
  ) as unknown as CollectSettingValues;

const naira = (minor: bigint) =>
  `₦${new Intl.NumberFormat('en').format(minor / 100n)}${
    minor % 100n === 0n ? '' : `.${String(minor % 100n).padStart(2, '0')}`
  }`;

const SETTING_WORDS: Record<
  (typeof SETTING_KEYS)[number],
  (s: CollectSettingValues) => string
> = {
  capMinor: (s) => naira(s.capMinor),
  capDays: (s) => `${s.capDays} days`,
  reminderDays: (s) => `days ${s.reminderDays.join(', ')}`,
  delayHours: (s) => `${s.delayHours} h`,
  delayForDays: (s) => `${s.delayForDays} days`,
  firstWithdrawalCapMinor: (s) => naira(s.firstWithdrawalCapMinor),
  newDailyLimitMinor: (s) => naira(s.newDailyLimitMinor),
  newDailyLimitDays: (s) => `${s.newDailyLimitDays} days`,
  reserveWarningMinor: (s) => naira(s.reserveWarningMinor),
  reserveCriticalMinor: (s) => naira(s.reserveCriticalMinor),
};
const SETTING_NAMES: Record<(typeof SETTING_KEYS)[number], string> = {
  capMinor: 'the holding cap',
  capDays: 'the holding cap’s days',
  reminderDays: 'the reminders',
  delayHours: 'the new-recipient delay',
  delayForDays: 'the new-recipient delay’s days',
  firstWithdrawalCapMinor: 'the first withdrawal cap',
  newDailyLimitMinor: 'the new-account daily limit',
  newDailyLimitDays: 'the new-account daily limit’s days',
  reserveWarningMinor: 'the reserve warning',
  reserveCriticalMinor: 'the reserve critical level',
};

/** "Change the holding cap from ₦50,000 to ₦100,000": each setting that moves, for the approver. */
export function describeCollectSettingsChange(
  from: CollectSettingValues,
  to: CollectSettingValues,
): string {
  const moved = SETTING_KEYS.filter(
    (key) => SETTING_WORDS[key](from) !== SETTING_WORDS[key](to),
  ).map(
    (key) =>
      `${SETTING_NAMES[key]} from ${SETTING_WORDS[key](from)} to ${SETTING_WORDS[key](to)}`,
  );
  return `Change ${moved.join('; ')}, for You collect from now`;
}

async function storeSettings(
  tx: Tx,
  input: {
    values: CollectSettingValues;
    paused: boolean;
    staffUserId: string;
    approvedBy: string | null;
    reason: string;
    now: Date;
  },
): Promise<string> {
  const id = newId();
  await tx.insert(collectSettings).values({
    id,
    ...input.values,
    reminderDays: [...input.values.reminderDays],
    paused: input.paused,
    effectiveFrom: input.now,
    setBy: input.staffUserId,
    approvedBy: input.approvedBy,
    reason: input.reason,
    createdAt: input.now,
  });
  return id;
}

/**
 * Stores new settings from now (the serious action's run: `approvedBy` is the second person, or null
 * when a lone admin acted alone with the alert). Staff's pause carries over unchanged. Refuses
 * settings out of bounds or the ones already in force. Audited from, to and approver.
 */
export async function setCollectSettings(
  tx: Tx,
  input: {
    values: CollectSettingValues;
    staffUserId: string;
    approvedBy: string | null;
    reason: string;
    now: Date;
  },
): Promise<{ id: string }> {
  const values = checkedCollectSettings(collectSettingsPayload(input.values));
  const previous = await collectSettingsInForce(tx, input.now);
  if (sameSettings(valuesOf(previous), values))
    throw new OperationError('INVALID_INPUT');
  const id = await storeSettings(tx, {
    ...input,
    values,
    paused: previous.paused,
  });
  await recordAudit(tx, {
    staffUserId: input.staffUserId,
    action: 'collect_settings.changed',
    permission: 'fees.manage',
    subjectType: 'collect_settings',
    subjectId: id,
    reason: withAuditChange(input.reason, {
      from: collectSettingsPayload(valuesOf(previous)),
      to: collectSettingsPayload(values),
      approvedBy: input.approvedBy,
    }),
    now: input.now,
  });
  return { id };
}

/**
 * Staff pause (or resume) every collect transfer (R11): a new row with every setting as in force and
 * `paused` changed. The transfer machine reads it before each row (Task 8). Refuses a pause while
 * paused and a resume while running, so the record always says what changed.
 */
export async function setCollectTransfersPaused(
  tx: Tx,
  input: {
    paused: boolean;
    staffUserId: string;
    approvedBy: string | null;
    reason: string;
    now: Date;
  },
): Promise<{ id: string; paused: boolean }> {
  const previous = await collectSettingsInForce(tx, input.now);
  if (previous.paused === input.paused)
    throw new OperationError('INVALID_INPUT');
  const id = await storeSettings(tx, {
    ...input,
    values: valuesOf(previous),
  });
  await recordAudit(tx, {
    staffUserId: input.staffUserId,
    action: input.paused
      ? 'collect_transfers.paused'
      : 'collect_transfers.resumed',
    permission: 'payments.repair',
    subjectType: 'collect_settings',
    subjectId: id,
    reason: withAuditChange(input.reason, {
      from: previous.paused,
      to: input.paused,
      approvedBy: input.approvedBy,
    }),
    now: input.now,
  });
  return { id, paused: input.paused };
}

/** Every stored row, newest first, for staff. */
export function collectSettingsHistory(db: Database | Tx, limit = 50) {
  return db
    .select()
    .from(collectSettings)
    .orderBy(
      desc(collectSettings.effectiveFrom),
      desc(collectSettings.createdAt),
    )
    .limit(limit);
}

/** A change, pause or resume still waiting for a second person, so the screen says so. */
export async function waitingCollectSettingsRequest(
  db: Database | Tx,
): Promise<string | null> {
  const [row] = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        inArray(approvalRequests.action, [
          COLLECT_SETTINGS_CHANGE_ACTION,
          COLLECT_TRANSFERS_PAUSE_ACTION,
          COLLECT_TRANSFERS_RESUME_ACTION,
        ]),
        eq(approvalRequests.status, 'pending'),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1);
  return row?.id ?? null;
}
