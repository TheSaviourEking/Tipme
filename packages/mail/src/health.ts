import { randomUUID } from 'node:crypto';
import type { MailProviderName } from './provider.js';

/*
 * A breaker per mail provider (automatic failover, owner 23 Nov 2026). Two signals trip it:
 * - `send`: definite send failures (timeouts, 5xx, network, refused key or account, credits),
 *   `threshold` of them within `windowMs`;
 * - `codes`: one-time codes sent through the provider that nobody used (the worker's check reads
 *   the database and calls trip), because ZeptoMail reports no deliveries.
 * Tripped, a provider rests for `restMs` and new mail goes to the backup. Then it is on trial: one
 * probe send after a `send` trip, the next `trialCodes` codes after a `codes` trip. A probe that
 * succeeds, or trial codes that get used, restore it; otherwise it rests again. The state lives in
 * Redis so the API (ops) and every worker agree; each step is one Lua script, so concurrent
 * processes never race. A lost state reads as healthy: normal behaviour. Staff hear a trip, a
 * provider still down (at most every 6 hours, the reserve alerts' rule) and a recovery.
 */

export type MailTripKind = 'send' | 'codes';

export interface MailHealthSettings {
  /** Definite failures within windowMs that trip (3). */
  threshold: number;
  windowMs: number;
  /** How long a tripped provider rests (15 minutes). */
  restMs: number;
  /** Codes let through on trial after a codes trip (3). */
  trialCodes: number;
  /** How long a provider that stays down goes between alerts. */
  realertMs?: number;
  /** A probe that never reported back frees the probe after this long. */
  probeLeaseMs?: number;
}

const REALERT_MS = 6 * 3_600_000;
const PROBE_LEASE_MS = 60_000;
/** Nothing is kept for a provider nobody touched in this long. */
const KEEP_MS = 30 * 86_400_000;

export type MailHealthChange = 'tripped' | 'still_down' | 'recovered';

/** What the store holds for one provider. Times are epoch milliseconds. */
export interface MailHealthRecord {
  state: 'closed' | 'open' | 'trial';
  kind: MailTripKind | null;
  until: number | null;
  reason: string | null;
  trippedAt: number | null;
  trialStartedAt: number | null;
  trialUsed: number;
  recoveredAt: number | null;
}

/** Each call is one atomic step, so processes sharing the store never race each other. */
export interface MailHealthStore {
  /** A definite send failure; may trip (`send`), or rest a provider on trial again. */
  fail(
    name: MailProviderName,
    now: number,
    reason: string,
  ): Promise<MailHealthChange | null>;
  /** Rests a provider now, whatever its count (unused codes, or unused trial codes). */
  trip(
    name: MailProviderName,
    now: number,
    reason: string,
    kind: MailTripKind,
  ): Promise<MailHealthChange | null>;
  /** Ends a trial of this kind successfully. */
  succeed(
    name: MailProviderName,
    now: number,
    kind: MailTripKind,
  ): Promise<MailHealthChange | null>;
  /** Takes one trial slot (the probe, or one of the trial codes) once the rest is over. */
  claim(name: MailProviderName, now: number, code: boolean): Promise<boolean>;
  /** Staff: back to healthy now. True when it was not healthy. */
  clear(name: MailProviderName, now: number): Promise<boolean>;
  read(
    names: readonly MailProviderName[],
  ): Promise<Map<MailProviderName, MailHealthRecord>>;
}

/** How routing and ops see a provider. */
export interface MailHealthView {
  /** `trial`: the rest is over and trial traffic decides (it may not have started). */
  state: 'healthy' | 'resting' | 'trial';
  kind: MailTripKind | null;
  /** Resting until then. */
  until: Date | null;
  /** The last trip's reason, kept after recovery. */
  reason: string | null;
  trippedAt: Date | null;
  trialStartedAt: Date | null;
  recoveredAt: Date | null;
}

const date = (ms: number | null) => (ms === null ? null : new Date(ms));

export function mailHealthView(
  record: MailHealthRecord | undefined,
  now: number,
): MailHealthView {
  if (!record)
    return {
      state: 'healthy',
      kind: null,
      until: null,
      reason: null,
      trippedAt: null,
      trialStartedAt: null,
      recoveredAt: null,
    };
  const common = {
    kind: record.kind,
    reason: record.reason,
    trippedAt: date(record.trippedAt),
    recoveredAt: date(record.recoveredAt),
  };
  if (record.state === 'closed')
    return { ...common, state: 'healthy', until: null, trialStartedAt: null };
  if (record.state === 'open' && record.until !== null && now < record.until)
    return {
      ...common,
      state: 'resting',
      until: new Date(record.until),
      trialStartedAt: null,
    };
  return {
    ...common,
    state: 'trial',
    until: null,
    trialStartedAt:
      record.state === 'trial' ? date(record.trialStartedAt) : null,
  };
}

interface MemoryEntry extends MailHealthRecord {
  failures: number[];
  alertedAt: number;
  probeUntil: number;
}

/** The same rules as the Redis store, in one process: unit tests. */
export function memoryMailHealthStore(
  settings: MailHealthSettings,
): MailHealthStore {
  const realert = settings.realertMs ?? REALERT_MS;
  const lease = settings.probeLeaseMs ?? PROBE_LEASE_MS;
  const entries = new Map<MailProviderName, MemoryEntry>();
  const entry = (name: MailProviderName): MemoryEntry => {
    let found = entries.get(name);
    if (!found) {
      found = {
        state: 'closed',
        kind: null,
        until: null,
        reason: null,
        trippedAt: null,
        trialStartedAt: null,
        trialUsed: 0,
        recoveredAt: null,
        failures: [],
        alertedAt: 0,
        probeUntil: 0,
      };
      entries.set(name, found);
    }
    return found;
  };
  const open = (
    e: MemoryEntry,
    now: number,
    reason: string,
    kind: MailTripKind,
  ) => {
    e.state = 'open';
    e.kind = kind;
    e.until = now + settings.restMs;
    e.reason = reason;
    e.trialStartedAt = null;
    e.trialUsed = 0;
    e.probeUntil = 0;
  };
  const reopen = (
    e: MemoryEntry,
    now: number,
    reason: string,
    kind: MailTripKind,
  ) => {
    open(e, now, reason, kind);
    if (now - e.alertedAt < realert) return null;
    e.alertedAt = now;
    return 'still_down' as const;
  };
  const trip = (
    e: MemoryEntry,
    now: number,
    reason: string,
    kind: MailTripKind,
  ) => {
    open(e, now, reason, kind);
    e.trippedAt = now;
    e.alertedAt = now;
    e.failures = [];
    return 'tripped' as const;
  };
  const close = (e: MemoryEntry, now: number) => {
    e.state = 'closed';
    e.until = null;
    e.trialStartedAt = null;
    e.trialUsed = 0;
    e.probeUntil = 0;
    e.failures = [];
    e.alertedAt = 0;
    e.recoveredAt = now;
  };
  return {
    async fail(name, now, reason) {
      const e = entry(name);
      if (e.state === 'trial') return reopen(e, now, reason, 'send');
      if (e.state === 'open') return null;
      e.failures = [...e.failures, now].filter(
        (at) => at > now - settings.windowMs,
      );
      return e.failures.length >= settings.threshold
        ? trip(e, now, reason, 'send')
        : null;
    },
    async trip(name, now, reason, kind) {
      const e = entry(name);
      if (e.state === 'open') return null;
      if (e.state === 'trial') return reopen(e, now, reason, kind);
      return trip(e, now, reason, kind);
    },
    async succeed(name, now, kind) {
      const e = entry(name);
      if (e.state !== 'trial' || e.kind !== kind) return null;
      close(e, now);
      return 'recovered';
    },
    async claim(name, now, code) {
      const e = entry(name);
      if (e.state === 'open') {
        if (e.until === null || now < e.until) return false;
        e.state = 'trial';
        e.trialStartedAt = now;
        e.trialUsed = 0;
        e.probeUntil = now + lease;
      }
      if (e.state !== 'trial') return false;
      if (e.kind === 'send') {
        if (now >= e.probeUntil) {
          e.trialUsed = 0;
          e.probeUntil = now + lease;
        }
        if (e.trialUsed >= 1) return false;
      } else if (!code || e.trialUsed >= settings.trialCodes) return false;
      e.trialUsed += 1;
      return true;
    },
    async clear(name, now) {
      const e = entry(name);
      if (e.state === 'closed') return false;
      close(e, now);
      return true;
    },
    async read(names) {
      const out = new Map<MailProviderName, MailHealthRecord>();
      for (const name of names) {
        const e = entries.get(name);
        if (e)
          out.set(name, {
            state: e.state,
            kind: e.kind,
            until: e.until,
            reason: e.reason,
            trippedAt: e.trippedAt,
            trialStartedAt: e.trialStartedAt,
            trialUsed: e.trialUsed,
            recoveredAt: e.recoveredAt,
          });
      }
      return out;
    },
  };
}

/** The one Redis command the store needs (an ioredis client has it). */
export interface MailHealthRedis {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

// Shared helpers. KEYS[1] the provider's hash, KEYS[2] its failure times (a sorted set).
const LUA_COMMON = `
local function open(h, now, rest, reason, kind)
  redis.call('HSET', h, 'state', 'open', 'kind', kind, 'until', now + rest, 'reason', reason,
    'trial_started_at', 0, 'trial_used', 0, 'probe_until', 0)
end
local function reopen(h, now, rest, reason, kind, realert)
  open(h, now, rest, reason, kind)
  local alerted = tonumber(redis.call('HGET', h, 'alerted_at') or '0')
  if now - alerted < realert then return '' end
  redis.call('HSET', h, 'alerted_at', now)
  return 'still_down'
end
local function trip(h, z, now, rest, reason, kind)
  open(h, now, rest, reason, kind)
  redis.call('HSET', h, 'tripped_at', now, 'alerted_at', now)
  redis.call('DEL', z)
  return 'tripped'
end
local function close(h, z, now)
  redis.call('HSET', h, 'state', 'closed', 'until', 0, 'trial_started_at', 0, 'trial_used', 0,
    'probe_until', 0, 'alerted_at', 0, 'recovered_at', now)
  redis.call('DEL', z)
end
local function keep(h, ms)
  redis.call('PEXPIRE', h, ms)
end
`;

// ARGV: now, reason, member, threshold, window, rest, realert, keep
const FAIL = `${LUA_COMMON}
local h, z = KEYS[1], KEYS[2]
local now, reason, member = tonumber(ARGV[1]), ARGV[2], ARGV[3]
local threshold, window, rest, realert = tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7])
local state = redis.call('HGET', h, 'state')
local out = ''
if state == 'trial' then out = reopen(h, now, rest, reason, 'send', realert)
elseif state == 'open' then return ''
else
  redis.call('ZADD', z, now, member)
  redis.call('ZREMRANGEBYSCORE', z, '-inf', now - window)
  redis.call('PEXPIRE', z, window)
  if redis.call('ZCARD', z) >= threshold then out = trip(h, z, now, rest, reason, 'send') else return '' end
end
keep(h, tonumber(ARGV[8]))
return out`;

// ARGV: now, reason, kind, rest, realert, keep
const TRIP = `${LUA_COMMON}
local h, z = KEYS[1], KEYS[2]
local now, reason, kind, rest, realert = tonumber(ARGV[1]), ARGV[2], ARGV[3], tonumber(ARGV[4]), tonumber(ARGV[5])
local state = redis.call('HGET', h, 'state')
local out
if state == 'open' then return '' end
if state == 'trial' then out = reopen(h, now, rest, reason, kind, realert)
else out = trip(h, z, now, rest, reason, kind) end
keep(h, tonumber(ARGV[6]))
return out`;

// ARGV: now, kind, keep
const SUCCEED = `${LUA_COMMON}
local h, z = KEYS[1], KEYS[2]
if redis.call('HGET', h, 'state') ~= 'trial' then return '' end
if redis.call('HGET', h, 'kind') ~= ARGV[2] then return '' end
close(h, z, tonumber(ARGV[1]))
keep(h, tonumber(ARGV[3]))
return 'recovered'`;

// ARGV: now, code (1/0), lease, trial codes
const CLAIM = `
local h = KEYS[1]
local now, code, lease, codes = tonumber(ARGV[1]), ARGV[2] == '1', tonumber(ARGV[3]), tonumber(ARGV[4])
local state = redis.call('HGET', h, 'state')
if state == 'open' then
  if now < tonumber(redis.call('HGET', h, 'until') or '0') then return 0 end
  redis.call('HSET', h, 'state', 'trial', 'trial_started_at', now, 'trial_used', 0, 'probe_until', now + lease)
  state = 'trial'
end
if state ~= 'trial' then return 0 end
local used = tonumber(redis.call('HGET', h, 'trial_used') or '0')
if redis.call('HGET', h, 'kind') == 'send' then
  if now >= tonumber(redis.call('HGET', h, 'probe_until') or '0') then
    used = 0
    redis.call('HSET', h, 'trial_used', 0, 'probe_until', now + lease)
  end
  if used >= 1 then return 0 end
else
  if not code or used >= codes then return 0 end
end
redis.call('HINCRBY', h, 'trial_used', 1)
return 1`;

// ARGV: now, keep
const CLEAR = `${LUA_COMMON}
local h, z = KEYS[1], KEYS[2]
local state = redis.call('HGET', h, 'state')
if not state or state == 'closed' then return 0 end
close(h, z, tonumber(ARGV[1]))
keep(h, tonumber(ARGV[2]))
return 1`;

const READ = `
local out = {}
for i, key in ipairs(KEYS) do out[i] = redis.call('HGETALL', key) end
return out`;

const asChange = (value: unknown): MailHealthChange | null =>
  value === 'tripped' || value === 'still_down' || value === 'recovered'
    ? value
    : null;

function recordOf(flat: unknown): MailHealthRecord | null {
  if (!Array.isArray(flat) || flat.length === 0) return null;
  const fields = new Map<string, string>();
  for (let i = 0; i + 1 < flat.length; i += 2)
    fields.set(String(flat[i]), String(flat[i + 1]));
  const state = fields.get('state');
  if (state !== 'closed' && state !== 'open' && state !== 'trial') return null;
  const time = (key: string) => {
    const value = Number(fields.get(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const kind = fields.get('kind');
  return {
    state,
    kind: kind === 'send' || kind === 'codes' ? kind : null,
    until: time('until'),
    reason: fields.get('reason') || null,
    trippedAt: time('tripped_at'),
    trialStartedAt: time('trial_started_at'),
    trialUsed: Number(fields.get('trial_used') ?? 0) || 0,
    recoveredAt: time('recovered_at'),
  };
}

/** The breaker's state in Redis, shared by the API and every worker. */
export function redisMailHealthStore(
  client: MailHealthRedis,
  options: MailHealthSettings & { prefix: string },
): MailHealthStore {
  const realert = options.realertMs ?? REALERT_MS;
  const lease = options.probeLeaseMs ?? PROBE_LEASE_MS;
  const hash = (name: MailProviderName) =>
    `${options.prefix}:mail-health:${name}`;
  const fails = (name: MailProviderName) => `${hash(name)}:fails`;
  const reasonText = (reason: string) => reason.slice(0, 120);
  return {
    async fail(name, now, reason) {
      return asChange(
        await client.eval(
          FAIL,
          2,
          hash(name),
          fails(name),
          now,
          reasonText(reason),
          `${now}:${randomUUID()}`,
          options.threshold,
          options.windowMs,
          options.restMs,
          realert,
          KEEP_MS,
        ),
      );
    },
    async trip(name, now, reason, kind) {
      return asChange(
        await client.eval(
          TRIP,
          2,
          hash(name),
          fails(name),
          now,
          reasonText(reason),
          kind,
          options.restMs,
          realert,
          KEEP_MS,
        ),
      );
    },
    async succeed(name, now, kind) {
      return asChange(
        await client.eval(
          SUCCEED,
          2,
          hash(name),
          fails(name),
          now,
          kind,
          KEEP_MS,
        ),
      );
    },
    async claim(name, now, code) {
      return (
        (await client.eval(
          CLAIM,
          1,
          hash(name),
          now,
          code ? '1' : '0',
          lease,
          options.trialCodes,
        )) === 1
      );
    },
    async clear(name, now) {
      return (
        (await client.eval(CLEAR, 2, hash(name), fails(name), now, KEEP_MS)) ===
        1
      );
    },
    async read(names) {
      const out = new Map<MailProviderName, MailHealthRecord>();
      if (names.length === 0) return out;
      const rows = await client.eval(READ, names.length, ...names.map(hash));
      names.forEach((name, i) => {
        const record = Array.isArray(rows) ? recordOf(rows[i]) : null;
        if (record) out.set(name, record);
      });
      return out;
    },
  };
}

export interface MailHealthChangeEvent {
  provider: MailProviderName;
  change: MailHealthChange;
  kind: MailTripKind | null;
  reason: string | null;
  /** When a rested provider goes on trial (tripped and still_down). */
  until: Date | null;
}

export interface MailHealth {
  /** A definite send failure (counts toward the breaker, or ends a trial). */
  failed(name: MailProviderName, code: string): Promise<void>;
  /** A send the provider accepted: ends a probe trial. */
  succeeded(name: MailProviderName): Promise<void>;
  /** Too many unused codes (or unused trial codes): rest the provider. */
  tripCodes(name: MailProviderName, reason: string): Promise<void>;
  /** Trial codes were used: the provider is back. */
  restoreCodes(name: MailProviderName): Promise<void>;
  /** Takes a trial slot for this mail. Never throws: false when the store can't be reached. */
  claim(name: MailProviderName, mail: { code: boolean }): Promise<boolean>;
  /** Staff cleared it by hand. Throws when the store can't be reached, so ops can say so. */
  clear(name: MailProviderName): Promise<boolean>;
  snapshot(
    names: readonly MailProviderName[],
  ): Promise<Map<MailProviderName, MailHealthView>>;
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/**
 * The breaker as delivery and ops use it. A store that fails (Redis down) never stops mail: every
 * provider reads healthy and nothing throws, and the log says so. `onChange` alerts staff; an
 * alert that fails is logged and never stops mail either.
 */
export function createMailHealth(options: {
  store: MailHealthStore;
  settings: MailHealthSettings;
  onChange?: (event: MailHealthChangeEvent) => Promise<void>;
  clock?: () => Date;
  log?: (entry: { event: string; provider?: string; error?: string }) => void;
}): MailHealth {
  const clock = options.clock ?? (() => new Date());
  const { settings } = options;
  const unavailable = (error: unknown) =>
    options.log?.({
      event: 'mail.health_unavailable',
      error: error instanceof Error ? error.name : 'unknown',
    });
  const announce = async (
    name: MailProviderName,
    change: MailHealthChange | null,
  ) => {
    if (!change || !options.onChange) return;
    const record = (await options.store.read([name])).get(name);
    const view = mailHealthView(record, clock().getTime());
    try {
      await options.onChange({
        provider: name,
        change,
        kind: view.kind,
        reason: view.reason,
        until: change === 'recovered' ? null : view.until,
      });
    } catch {
      options.log?.({ event: 'mail.health_alert_failed', provider: name });
    }
  };
  const guarded = async (
    name: MailProviderName,
    step: () => Promise<MailHealthChange | null>,
  ) => {
    try {
      await announce(name, await step());
    } catch (error) {
      unavailable(error);
    }
  };
  const now = () => clock().getTime();
  return {
    failed: (name, code) =>
      guarded(name, () =>
        options.store.fail(
          name,
          now(),
          `${settings.threshold} send failures in ${minutes(settings.windowMs)} (last: ${code})`,
        ),
      ),
    succeeded: (name) =>
      guarded(name, () => options.store.succeed(name, now(), 'send')),
    tripCodes: (name, reason) =>
      guarded(name, () => options.store.trip(name, now(), reason, 'codes')),
    restoreCodes: (name) =>
      guarded(name, () => options.store.succeed(name, now(), 'codes')),
    async claim(name, mail) {
      try {
        return await options.store.claim(name, now(), mail.code);
      } catch (error) {
        unavailable(error);
        return false;
      }
    },
    clear: (name) => options.store.clear(name, now()),
    async snapshot(names) {
      const at = now();
      let records = new Map<MailProviderName, MailHealthRecord>();
      try {
        records = await options.store.read(names);
      } catch (error) {
        unavailable(error);
      }
      return new Map(
        names.map((name) => [name, mailHealthView(records.get(name), at)]),
      );
    },
  };
}
