import { z } from 'zod';
import { opsReasonSchema } from './ops.js';

/**
 * Feature switches staff set in admin (owner, 14 Nov 2026; docs/runbooks/settings-and-switches.md).
 * Each replaces an environment variable, which only seeds it on the first start after release.
 * One list for the database, the API, the worker and the admin screen.
 */
export const FEATURE_SWITCHES = [
  'pro_billing',
  'pro_pay_from_balance',
  'pro_refunds',
  'pro_auto_renew',
  'business',
  'business_shares',
  'team_tips',
  'analytics',
  'adult_platform_links',
  'supporter_recognition',
  // Page Studio, PR #210 (feat/page-studio-1): registered so it reads this switch, not a variable.
  'page_studio',
  // Returning TipMe's fee on a refunded tip, PR #193 (feat/business-r2-b): registered likewise.
  'refund_fee_return',
] as const;
export type FeatureSwitch = (typeof FEATURE_SWITCHES)[number];

export interface FeatureSwitchEntry {
  label: string;
  /** Plain words for staff: what turning it on does. */
  description: string;
  /** Moves or can move money: a change is the serious action `feature_switch.set`. */
  money: boolean;
  /** Before any value is stored or readable. Never on for a money switch. */
  default: boolean;
  /** The variable it replaces, and that variable's own words for on and off. */
  env: { name: string; on: 'true' | 'on'; off: 'false' | 'off' };
}

const truthy = (name: string) => ({ name, on: 'true', off: 'false' }) as const;
const onOff = (name: string) => ({ name, on: 'on', off: 'off' }) as const;

export const FEATURE_SWITCH_CATALOGUE: Record<
  FeatureSwitch,
  FeatureSwitchEntry
> = {
  pro_billing: {
    label: 'Pro billing',
    description:
      'Recipients can buy a month of Pro. Real money also needs live payments on and the page let through.',
    money: true,
    default: false,
    env: truthy('PRO_BILLING_ENABLED'),
  },
  pro_pay_from_balance: {
    label: 'Pay for Pro from the balance',
    description:
      'Recipients can pay for Pro from their TipMe balance, not only by card.',
    money: true,
    default: false,
    env: onOff('PRO_PAY_FROM_BALANCE'),
  },
  pro_refunds: {
    label: 'Pro refunds',
    description:
      'Staff can refund a Pro month paid by card, within 14 days, with a second person.',
    money: true,
    default: false,
    env: onOff('PRO_REFUNDS'),
  },
  pro_auto_renew: {
    label: 'Pro auto-renew',
    description:
      'Recipients can let Pro renew on a saved card, and the card is charged a day before the month ends.',
    money: true,
    default: false,
    env: onOff('PRO_AUTO_RENEW'),
  },
  business: {
    label: 'TipMe for businesses',
    description:
      'Businesses, their pages and their staff. Off, every business page answers as if it did not exist.',
    money: false,
    default: false,
    env: truthy('BUSINESS_ENABLED'),
  },
  business_shares: {
    label: 'Business shares',
    description:
      'A business can agree a share of its staff’s tips, and has its own balance. Needs TipMe for businesses on.',
    money: true,
    default: false,
    env: truthy('BUSINESS_SHARES_ENABLED'),
  },
  team_tips: {
    label: 'Team tips',
    description:
      'Supporters can tip a whole business team at once. Needs TipMe for businesses on.',
    money: true,
    default: false,
    env: truthy('TEAM_TIPS_ENABLED'),
  },
  analytics: {
    label: 'Visit counts',
    description:
      'Anonymous, cookieless counts of visits and outcomes. Off, nothing new is collected.',
    money: false,
    default: true,
    env: truthy('ANALYTICS_ENABLED'),
  },
  adult_platform_links: {
    label: 'OnlyFans and Fansly links',
    description:
      'Pro pages can show OnlyFans and Fansly links. Off hides them everywhere and refuses new ones; nothing is deleted.',
    money: false,
    default: true,
    env: onOff('ADULT_PLATFORM_LINKS'),
  },
  supporter_recognition: {
    label: 'Repeat supporters',
    description:
      'Pro pages offer supporters “recognise me next time”. Off hides the tick box and records nothing new.',
    money: false,
    default: true,
    env: onOff('SUPPORTER_RECOGNITION'),
  },
  page_studio: {
    label: 'Page Studio',
    description: 'Pro pages can use Page Studio’s colours and fonts.',
    money: false,
    default: false,
    env: truthy('PAGE_STUDIO_ENABLED'),
  },
  refund_fee_return: {
    label: 'Return the fee on refunds',
    description:
      'When a tip is refunded, TipMe gives back the fee it kept for that tip.',
    money: true,
    default: false,
    env: truthy('REFUND_FEE_RETURN'),
  },
};

export function isFeatureSwitch(key: string): key is FeatureSwitch {
  return (FEATURE_SWITCHES as readonly string[]).includes(key);
}

/**
 * The value an old variable gives, in that variable's own words (`true`/`false` or `on`/`off`).
 * Unset or blank is no value. Anything else throws, naming the variable but never the value, as the
 * config schema used to refuse it at start.
 */
export function featureSwitchFromEnv(
  key: FeatureSwitch,
  env: Record<string, string | undefined>,
): boolean | undefined {
  const { name, on, off } = FEATURE_SWITCH_CATALOGUE[key].env;
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  if (raw === on) return true;
  if (raw === off) return false;
  throw new Error(`${name} must be ${on} or ${off}`);
}

export const FEATURE_SWITCH_SOURCES = ['default', 'env', 'staff'] as const;
export type FeatureSwitchSource = (typeof FEATURE_SWITCH_SOURCES)[number];

/** One change of a switch, newest first on the screen. */
export interface OpsFeatureSwitchChange {
  id: string;
  on: boolean;
  source: FeatureSwitchSource;
  /** Staff ids; null for a value seeded at start. */
  changedBy: string | null;
  approvedBy: string | null;
  reason: string;
  createdAt: string;
}

export interface OpsFeatureSwitch {
  key: FeatureSwitch;
  label: string;
  description: string;
  money: boolean;
  on: boolean;
  default: boolean;
  /** The variable it replaced, so staff can match it to the old settings. */
  envName: string;
  source: FeatureSwitchSource | null;
  changedBy: string | null;
  changedAt: string | null;
  reason: string | null;
  /** A change waiting for a second person, if any. */
  waitingRequestId: string | null;
  history: OpsFeatureSwitchChange[];
}

/** `GET /v1/ops/switches`. */
export interface OpsFeatureSwitches {
  switches: OpsFeatureSwitch[];
}

/** `POST /v1/ops/switches/{key}`: turn it on or off, with a reason. */
export const opsFeatureSwitchSetSchema = opsReasonSchema
  .extend({ on: z.boolean() })
  .strict();
export type OpsFeatureSwitchSetRequest = z.infer<
  typeof opsFeatureSwitchSetSchema
>;

/**
 * The old switch variables present in an environment, checked: a config keeps these only to seed the
 * switches on the first start after release. Blank is unset; a malformed one throws, naming it.
 */
export function featureSwitchSeedsFrom(
  env: Record<string, string | undefined>,
  keys: readonly FeatureSwitch[] = FEATURE_SWITCHES,
): Record<string, string> {
  const seeds: Record<string, string> = {};
  for (const key of keys) {
    if (featureSwitchFromEnv(key, env) === undefined) continue;
    const { name } = FEATURE_SWITCH_CATALOGUE[key].env;
    seeds[name] = env[name] as string;
  }
  return seeds;
}
