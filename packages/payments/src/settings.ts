import { bachsEnvironment, recordedProviderName } from '@tipme/contracts';
import { isProductionCopy } from '@tipme/observability';
import { z } from 'zod';

export { bachsEnvironment, recordedProviderName };

/**
 * Payment settings shared by the API and the worker. Messages name settings and never show
 * values. Live payments are possible only with `bachs-live` on a production copy; production
 * may start with them switched off (PAYMENTS_LIVE_ENABLED=false) while checkout stays closed.
 */
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

export const PAYMENT_PROVIDER_NAMES = [
  'mock',
  'bachs-sandbox',
  'bachs-live',
] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDER_NAMES)[number];

/** Providers that may be withdraw-only: pay out money already held, take no new tips. */
export const WITHDRAW_ONLY_PROVIDER_NAMES = [
  'mock',
  'mock_alt',
  'bachs-sandbox',
  'bachs-live',
] as const;
export type WithdrawOnlyProviderName =
  (typeof WITHDRAW_ONLY_PROVIDER_NAMES)[number];

export const paymentSettingsShape = {
  // mock and bachs-sandbox: test and password-protected preview only. bachs-live: production only.
  PAYMENT_PROVIDER: z.enum(PAYMENT_PROVIDER_NAMES).default('mock'),
  // Comma list of providers that only pay out (see docs/runbooks/settings-and-switches.md). Never
  // set on production while only bachs-live exists.
  PAYMENT_WITHDRAW_ONLY_PROVIDERS: z
    .string()
    .default('')
    .transform((raw, context): WithdrawOnlyProviderName[] => {
      const items = raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const known: readonly string[] = WITHDRAW_ONLY_PROVIDER_NAMES;
      if (items.some((item) => !known.includes(item))) {
        context.addIssue({
          code: 'custom',
          message: `must be provider names (${WITHDRAW_ONLY_PROVIDER_NAMES.join(', ')}) separated by commas`,
        });
        return [];
      }
      return items as WithdrawOnlyProviderName[];
    }),
  // Whether checkout takes real money. Only meaningful (and only allowed) with bachs-live.
  PAYMENTS_LIVE_ENABLED: flag,
  BACHS_SANDBOX_API_KEY: z
    .string()
    .regex(/^sk_sandbox_.+$/)
    .optional(),
  BACHS_LIVE_API_KEY: z
    .string()
    .regex(/^sk_live_.+$/)
    .optional(),
  // Paid Pro (ADR-0015): TipMe's own organization at the partner. Events without a top-level
  // `account` from this organization are TipMe's own (Pro purchases). Unset: every event is a
  // connected account's, as before, so nothing changes until it is set.
  BACHS_PLATFORM_ORGANIZATION_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
};

/** Webhook secrets: the API authenticates Bachs callbacks; the worker never holds them. */
export const paymentWebhookSettingsShape = {
  BACHS_WEBHOOK_SECRET: z.string().min(16).optional(),
  BACHS_PREVIOUS_WEBHOOK_SECRET: z.string().min(16).optional(),
  BACHS_LIVE_WEBHOOK_SECRET: z.string().min(16).optional(),
  BACHS_LIVE_PREVIOUS_WEBHOOK_SECRET: z.string().min(16).optional(),
};

const CHECKOUT_HANDLE = /^[a-z0-9_-]{1,64}$/;

/**
 * Who may take real tips while live payments are on: the limited stage (docs/runbooks/live-activation.md).
 * A comma-separated list of current handles; `*` alone opens checkout to everyone. Unset or blank is
 * nobody, so turning live payments on never opens checkout by itself. API only.
 */
export const liveCheckoutSettingsShape = {
  LIVE_CHECKOUT_HANDLES: z
    .string()
    .optional()
    .transform((raw, context): '*' | string[] => {
      const items = (raw ?? '')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      if (items.length === 1 && items[0] === '*') return '*';
      if (items.some((item) => !CHECKOUT_HANDLE.test(item)))
        context.addIssue({
          code: 'custom',
          message: 'must be handles separated by commas, or * alone',
        });
      return items;
    }),
};

/**
 * Whether a page can take a tip now: the one rule behind checkout and the public page. `handle` is
 * the page's current handle, lower-cased, so an old name in the list never opens it. Test copies
 * never close for this; Bachs live needs the switch on and the page named.
 */
export function liveCheckoutOpenFor(
  config: {
    PAYMENT_PROVIDER: string;
    PAYMENTS_LIVE_ENABLED?: boolean | undefined;
    LIVE_CHECKOUT_HANDLES?: '*' | readonly string[] | undefined;
  },
  handle: string,
): boolean {
  if (!isLiveProvider(config.PAYMENT_PROVIDER)) return true;
  if (!config.PAYMENTS_LIVE_ENABLED) return false;
  const allowed = config.LIVE_CHECKOUT_HANDLES ?? [];
  return allowed === '*' || allowed.includes(handle);
}

export interface PaymentSettings {
  NODE_ENV?: string | undefined;
  DEPLOYMENT_MODE?: string | undefined;
  PAYMENT_PROVIDER: PaymentProviderName;
  PAYMENTS_LIVE_ENABLED: boolean;
  PAYMENT_WITHDRAW_ONLY_PROVIDERS?:
    readonly WithdrawOnlyProviderName[] | undefined;
  BACHS_SANDBOX_API_KEY?: string | undefined;
  BACHS_LIVE_API_KEY?: string | undefined;
  BACHS_WEBHOOK_SECRET?: string | undefined;
  BACHS_PREVIOUS_WEBHOOK_SECRET?: string | undefined;
  BACHS_LIVE_WEBHOOK_SECRET?: string | undefined;
  BACHS_LIVE_PREVIOUS_WEBHOOK_SECRET?: string | undefined;
}

export function isLiveProvider(name: string): name is 'bachs-live' {
  return name === 'bachs-live';
}

function checkWithdrawOnlyProviders(
  s: PaymentSettings,
  issue: (path: string, message: string) => void,
  production: boolean,
  options: { webhooks: boolean },
): void {
  const path = 'PAYMENT_WITHDRAW_ONLY_PROVIDERS';
  const seen = new Set<string>();
  for (const name of s.PAYMENT_WITHDRAW_ONLY_PROVIDERS ?? []) {
    if (seen.has(name)) {
      issue(path, `${name} is listed twice`);
      continue;
    }
    seen.add(name);
    if (name === s.PAYMENT_PROVIDER) {
      issue(path, `${name} is the active provider`);
      continue;
    }
    if ((name === 'mock' || name === 'mock_alt') && production)
      issue(path, `${name} not allowed in production`);
    if (name === 'mock_alt' && s.NODE_ENV !== 'test')
      issue(path, 'mock_alt is allowed only under NODE_ENV=test');
    if (
      bachsEnvironment(name) &&
      recordedProviderName(name) === recordedProviderName(s.PAYMENT_PROVIDER)
    )
      issue(
        path,
        `${name} is the same partner as the active provider in another environment`,
      );
    if (name === 'bachs-sandbox') {
      if (production)
        issue(
          path,
          'bachs-sandbox is allowed only in test or password-protected preview',
        );
      if (!s.BACHS_SANDBOX_API_KEY)
        issue(path, 'bachs-sandbox needs BACHS_SANDBOX_API_KEY');
      if (options.webhooks && !s.BACHS_WEBHOOK_SECRET)
        issue(path, 'bachs-sandbox needs BACHS_WEBHOOK_SECRET');
    }
    if (name === 'bachs-live') {
      if (!production) issue(path, 'bachs-live is allowed only in production');
      if (!s.BACHS_LIVE_API_KEY)
        issue(path, 'bachs-live needs BACHS_LIVE_API_KEY');
      if (options.webhooks && !s.BACHS_LIVE_WEBHOOK_SECRET)
        issue(path, 'bachs-live needs BACHS_LIVE_WEBHOOK_SECRET');
    }
  }
}

/** The one place both apps read provider roles: the active provider and the withdraw-only ones. */
export function configuredPaymentProviders(config: {
  PAYMENT_PROVIDER: PaymentProviderName;
  PAYMENT_WITHDRAW_ONLY_PROVIDERS: readonly WithdrawOnlyProviderName[];
}): { active: PaymentProviderName; withdrawOnly: WithdrawOnlyProviderName[] } {
  return {
    active: config.PAYMENT_PROVIDER,
    withdrawOnly: [...config.PAYMENT_WITHDRAW_ONLY_PROVIDERS],
  };
}

/**
 * Validation shared by both configs (use inside their superRefine). `webhooks` is true where
 * the webhook secrets are read (the API); the worker needs the Bachs API key alone.
 */
export function checkPaymentSettings(
  s: PaymentSettings,
  context: z.RefinementCtx,
  options: { webhooks: boolean },
): void {
  const issue = (path: string, message: string) =>
    context.addIssue({ code: 'custom', path: [path], message });
  const production = isProductionCopy(s);
  const provider = s.PAYMENT_PROVIDER;

  if (provider === 'mock' && production)
    issue('PAYMENT_PROVIDER', 'mock not allowed in production');
  if (provider === 'bachs-sandbox') {
    if (production)
      issue(
        'PAYMENT_PROVIDER',
        'Bachs sandbox is allowed only in test or password-protected preview',
      );
    if (!s.BACHS_SANDBOX_API_KEY)
      issue('BACHS_SANDBOX_API_KEY', 'required for Bachs sandbox');
  }
  if (provider === 'bachs-live') {
    if (!production)
      issue('PAYMENT_PROVIDER', 'Bachs live is allowed only in production');
    if (!s.BACHS_LIVE_API_KEY)
      issue('BACHS_LIVE_API_KEY', 'required for Bachs live');
    if (options.webhooks && !s.BACHS_LIVE_WEBHOOK_SECRET)
      issue('BACHS_LIVE_WEBHOOK_SECRET', 'required for Bachs live');
  }
  checkWithdrawOnlyProviders(s, issue, production, options);
  if (s.PAYMENTS_LIVE_ENABLED && !isLiveProvider(provider))
    issue('PAYMENTS_LIVE_ENABLED', 'requires the bachs-live provider');
  if (
    production &&
    (s.BACHS_SANDBOX_API_KEY ||
      s.BACHS_WEBHOOK_SECRET ||
      s.BACHS_PREVIOUS_WEBHOOK_SECRET)
  )
    issue(
      'BACHS_SANDBOX_API_KEY',
      'Bachs sandbox credentials are restricted to test or preview',
    );
  if (
    !production &&
    (s.BACHS_LIVE_API_KEY ||
      s.BACHS_LIVE_WEBHOOK_SECRET ||
      s.BACHS_LIVE_PREVIOUS_WEBHOOK_SECRET)
  )
    issue(
      'BACHS_LIVE_API_KEY',
      'Bachs live credentials are restricted to production',
    );
}

/**
 * The provider a process runs. Exhaustive on purpose: a new provider name cannot be added
 * without a branch here, and an unknown one (untyped config) stops startup rather than quietly
 * falling back to the pretend provider.
 */
export function wiredPaymentProvider(
  name: PaymentProviderName,
): PaymentProviderName {
  switch (name) {
    case 'mock':
    case 'bachs-sandbox':
    case 'bachs-live':
      return name;
    default: {
      const unreachable: never = name;
      throw new Error(`PAYMENT_PROVIDER=${String(unreachable)} is not wired`);
    }
  }
}
