import {
  parseProductionLaunchAt,
  type PublicDisplaySettings,
} from '@tipme/contracts';

// The pilot notice and the launch time, set in admin (owner, 14 Nov 2026, #216), on the API's public
// /health/release. Until staff first set one there (`set: false`) the web keeps its old Vercel setting,
// so release day changes nothing; those lines can be deleted once both are set in admin. Unreadable
// (the API down, nothing read yet) is no notice and no launch gate: the old settings' unset behaviour.

export type DisplaySettings = PublicDisplaySettings;
type Env = Record<string, string | undefined>;

const isFlag = (v: unknown): v is { set: boolean; on: boolean } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { set?: unknown }).set === 'boolean' &&
  typeof (v as { on?: unknown }).on === 'boolean';

const isLaunch = (v: unknown): v is { set: boolean; at: string | null } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { set?: unknown }).set === 'boolean' &&
  ((v as { at?: unknown }).at === null ||
    typeof (v as { at?: unknown }).at === 'string');

/** The settings in a release answer, or null when they can't be read. */
export function displaySettingsOf(release: unknown): DisplaySettings | null {
  if (typeof release !== 'object' || release === null) return null;
  const display = (release as { display?: unknown }).display;
  if (typeof display !== 'object' || display === null) return null;
  const { pilotNotice, launch } = display as Record<string, unknown>;
  if (!isFlag(pilotNotice) || !isLaunch(launch)) return null;
  return { pilotNotice, launch };
}

/** Whether the pilot notice is switched on (it still shows only in live mode). */
export function pilotNoticeFrom(
  settings: DisplaySettings | null,
  env: Env,
): boolean {
  if (!settings) return false;
  if (settings.pilotNotice.set) return settings.pilotNotice.on;
  return env['PILOT_NOTICE'] === 'on';
}

/** The launch instant in ms, or null for none (TipMe is open). */
export function launchTargetFrom(
  settings: DisplaySettings | null,
  env: Env,
): number | null {
  if (!settings) return null;
  if (settings.launch.set)
    return settings.launch.at === null ? null : Date.parse(settings.launch.at);
  return parseProductionLaunchAt(env['PRODUCTION_LAUNCH_AT']);
}

/**
 * Reads at most once a minute while the API answers. A failure keeps the last value read (for a few
 * seconds, then asks again), and with none returns null. Reads at the same moment share one request.
 */
export function createDisplaySettingsReader({
  read,
  now,
  okMs = 60_000,
  failedMs = 5_000,
}: {
  read: () => Promise<unknown>;
  now: () => number;
  okMs?: number;
  failedMs?: number;
}): () => Promise<DisplaySettings | null> {
  let kept: { value: DisplaySettings | null; until: number } | null = null;
  let pending: Promise<DisplaySettings | null> | null = null;
  return () => {
    if (kept && now() < kept.until) return Promise.resolve(kept.value);
    const last = kept?.value ?? null;
    pending ??= read()
      .then(
        (release) => {
          const value = displaySettingsOf(release);
          return value ? { value, ms: okMs } : { value: last, ms: failedMs };
        },
        () => ({ value: last, ms: failedMs }),
      )
      .then(({ value, ms }) => {
        kept = { value, until: now() + ms };
        pending = null;
        return value;
      });
    return pending;
  };
}
