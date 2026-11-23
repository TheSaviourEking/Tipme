import { z } from 'zod';
import { createMockMailProvider } from './mock/provider.js';
import type {
  MailProvider,
  MailProviderName,
  OutgoingMail,
} from './provider.js';
import { createBrevoProvider } from './brevo/provider.js';
import { createSesProvider } from './ses/provider.js';
import { createZeptoMailProvider } from './zeptomail/provider.js';

/**
 * Mail settings shared by the API (webhooks, tests, status) and the worker (sending). Secrets
 * are never logged and never appear in configuration errors, which name keys only.
 */
export const mailSettingsShape = {
  // Sends until staff choose a provider in ops. mock is refused in production; brevo needs
  // BREVO_TRANSACTIONAL=on.
  MAIL_DEFAULT_PROVIDER: z
    .enum(['mock', 'zeptomail', 'ses', 'brevo'])
    .default('mock'),
  ZEPTOMAIL_API_KEY: z.string().min(8).optional(),
  // The account's data-centre API base, e.g. https://api.zeptomail.com (no path).
  ZEPTOMAIL_API_BASE: z.url({ protocol: /^https$/ }).optional(),
  ZEPTOMAIL_WEBHOOK_KEY: z.string().min(8).optional(),
  ZEPTOMAIL_BOUNCE_ADDRESS: z.email().optional(),
  SES_REGION: z
    .string()
    .regex(/^[a-z]{2}-[a-z]+-\d$/)
    .default('eu-north-1'),
  // Omitted: the SDK's default credential chain (e.g. the machine's role).
  SES_ACCESS_KEY_ID: z.string().min(16).optional(),
  SES_SECRET_ACCESS_KEY: z.string().min(16).optional(),
  SES_CONFIGURATION_SET: z.string().min(1).optional(),
  SES_CONFIGURATION_SET_UNTRACKED: z.string().min(1).optional(),
  SES_SNS_TOPIC_ARN: z
    .string()
    .regex(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[\w-]+$/)
    .optional(),
  // Announcements (owner, 14 Nov 2026) always go through Brevo, never the provider above, and
  // with BREVO_TRANSACTIONAL=on other mail may too. Optional: without them, announcements can't be
  // sent in production ("Announcement email isn't set up").
  BREVO_API_KEY: z.string().min(8).optional(),
  // Code defaults, not deploy settings (owner, 14 Nov 2026): overrides for tests and emergencies.
  BREVO_API_BASE: z
    .url({ protocol: /^https$/ })
    .default('https://api.brevo.com'),
  // The bearer token set on Brevo's webhook; without it Brevo's bounce reports are refused.
  BREVO_WEBHOOK_TOKEN: z.string().min(16).optional(),
  // on: Brevo checks each request and sends nothing (X-Sib-Sandbox: drop).
  BREVO_SANDBOX: z
    .enum(['on', 'off'])
    .default('off')
    .transform((value) => value === 'on'),
  // The verified sender of every announcement, e.g. news@usetipme.xyz.
  ANNOUNCEMENT_FROM_ADDRESS: z.email().optional(),
  // on: Brevo is also a provider staff can switch codes, receipts and alerts to in ops (owner,
  // 23 Nov 2026), by hand only: no automatic fallback. Needs BREVO_API_KEY and BREVO_WEBHOOK_TOKEN.
  // Each mail comes from its own type's sender on the mail domain, as with ZeptoMail.
  BREVO_TRANSACTIONAL: z
    .enum(['on', 'off'])
    .default('off')
    .transform((value) => value === 'on'),
  // on: Brevo checks each code, receipt and alert and sends nothing. Separate from BREVO_SANDBOX
  // (announcements) so staging can keep announcements dropped while codes really arrive.
  BREVO_TRANSACTIONAL_SANDBOX: z
    .enum(['on', 'off'])
    .default('off')
    .transform((value) => value === 'on'),
};

export interface MailSettings {
  NODE_ENV?: string;
  DEPLOYMENT_MODE?: string;
  MAIL_DEFAULT_PROVIDER: MailProviderName;
  ZEPTOMAIL_API_KEY?: string | undefined;
  ZEPTOMAIL_API_BASE?: string | undefined;
  ZEPTOMAIL_WEBHOOK_KEY?: string | undefined;
  ZEPTOMAIL_BOUNCE_ADDRESS?: string | undefined;
  SES_REGION: string;
  SES_ACCESS_KEY_ID?: string | undefined;
  SES_SECRET_ACCESS_KEY?: string | undefined;
  SES_CONFIGURATION_SET?: string | undefined;
  SES_CONFIGURATION_SET_UNTRACKED?: string | undefined;
  SES_SNS_TOPIC_ARN?: string | undefined;
  BREVO_API_KEY?: string | undefined;
  BREVO_API_BASE?: string | undefined;
  BREVO_WEBHOOK_TOKEN?: string | undefined;
  BREVO_SANDBOX?: boolean | undefined;
  ANNOUNCEMENT_FROM_ADDRESS?: string | undefined;
  BREVO_TRANSACTIONAL?: boolean | undefined;
  BREVO_TRANSACTIONAL_SANDBOX?: boolean | undefined;
}

const ZEPTO_KEYS = [
  'ZEPTOMAIL_API_KEY',
  'ZEPTOMAIL_API_BASE',
  'ZEPTOMAIL_WEBHOOK_KEY',
] as const;
const BREVO_KEYS = ['BREVO_API_KEY', 'ANNOUNCEMENT_FROM_ADDRESS'] as const;
/** What BREVO_TRANSACTIONAL=on needs: the key, and the token its delivery reports carry. */
const BREVO_TRANSACTIONAL_KEYS = [
  'BREVO_API_KEY',
  'BREVO_WEBHOOK_TOKEN',
] as const;
const SES_KEYS = [
  'SES_CONFIGURATION_SET',
  'SES_CONFIGURATION_SET_UNTRACKED',
  'SES_SNS_TOPIC_ARN',
] as const;

const isProduction = (s: MailSettings) =>
  s.NODE_ENV === 'production' && s.DEPLOYMENT_MODE !== 'preview';

/** All or none: which of a provider's keys are missing when some are set. */
function partial(s: MailSettings, keys: readonly (keyof MailSettings)[]) {
  const set = keys.filter((key) => s[key] !== undefined);
  return set.length === 0 ? null : keys.filter((key) => s[key] === undefined);
}

export function configuredMailProviderNames(
  s: MailSettings,
): Set<MailProviderName> {
  const names = new Set<MailProviderName>();
  if (!isProduction(s)) names.add('mock');
  if (partial(s, ZEPTO_KEYS)?.length === 0) names.add('zeptomail');
  if (partial(s, SES_KEYS)?.length === 0) names.add('ses');
  if (
    s.BREVO_TRANSACTIONAL === true &&
    BREVO_TRANSACTIONAL_KEYS.every((key) => s[key] !== undefined)
  )
    names.add('brevo');
  return names;
}

/** Validation shared by both configs (use inside their superRefine). */
export function checkMailSettings(
  s: MailSettings,
  context: z.RefinementCtx,
): void {
  const issue = (path: string, message: string) =>
    context.addIssue({ code: 'custom', path: [path], message });
  for (const key of partial(s, ZEPTO_KEYS) ?? [])
    issue(key, 'required with the other ZeptoMail settings');
  for (const key of partial(s, SES_KEYS) ?? [])
    issue(key, 'required with the other SES settings');
  const brevoMissing = new Set<string>();
  if (s.BREVO_TRANSACTIONAL === true)
    for (const key of BREVO_TRANSACTIONAL_KEYS)
      if (s[key] === undefined) {
        brevoMissing.add(key);
        issue(key, 'required with BREVO_TRANSACTIONAL=on');
      }
  // A key used for codes and receipts doesn't need an announcement sender too.
  for (const key of partial(s, BREVO_KEYS) ?? [])
    if (
      !brevoMissing.has(key) &&
      !(key === 'ANNOUNCEMENT_FROM_ADDRESS' && s.BREVO_TRANSACTIONAL === true)
    )
      issue(key, 'required with the other announcement email settings');
  if (
    (s.SES_ACCESS_KEY_ID === undefined) !==
    (s.SES_SECRET_ACCESS_KEY === undefined)
  )
    issue(
      s.SES_ACCESS_KEY_ID === undefined
        ? 'SES_ACCESS_KEY_ID'
        : 'SES_SECRET_ACCESS_KEY',
      'set both SES access keys, or neither',
    );
  if (s.MAIL_DEFAULT_PROVIDER === 'mock' && isProduction(s))
    issue('MAIL_DEFAULT_PROVIDER', 'mock not allowed in production');
  else if (!configuredMailProviderNames(s).has(s.MAIL_DEFAULT_PROVIDER))
    issue('MAIL_DEFAULT_PROVIDER', 'provider not configured');
}

/** The configured providers, keyed by name. The pretend one writes to `mockSink`. */
export function configuredMailProviders(
  s: MailSettings,
  mockSink: (mail: OutgoingMail) => Promise<void>,
  /** Tests only: what Brevo's requests go through. */
  options: { fetchImpl?: typeof fetch } = {},
): Map<MailProviderName, MailProvider> {
  const names = configuredMailProviderNames(s);
  const providers = new Map<MailProviderName, MailProvider>();
  if (names.has('mock'))
    providers.set('mock', createMockMailProvider(mockSink));
  if (names.has('zeptomail'))
    providers.set(
      'zeptomail',
      createZeptoMailProvider({
        apiKey: s.ZEPTOMAIL_API_KEY!,
        apiBase: s.ZEPTOMAIL_API_BASE!,
        webhookKey: s.ZEPTOMAIL_WEBHOOK_KEY!,
        ...(s.ZEPTOMAIL_BOUNCE_ADDRESS
          ? { bounceAddress: s.ZEPTOMAIL_BOUNCE_ADDRESS }
          : {}),
      }),
    );
  if (names.has('ses'))
    providers.set(
      'ses',
      createSesProvider({
        region: s.SES_REGION,
        configurationSet: s.SES_CONFIGURATION_SET!,
        configurationSetUntracked: s.SES_CONFIGURATION_SET_UNTRACKED!,
        topicArn: s.SES_SNS_TOPIC_ARN!,
        ...(s.SES_ACCESS_KEY_ID && s.SES_SECRET_ACCESS_KEY
          ? {
              credentials: {
                accessKeyId: s.SES_ACCESS_KEY_ID,
                secretAccessKey: s.SES_SECRET_ACCESS_KEY,
              },
            }
          : {}),
      }),
    );
  // The announcement account's key, as its own instance: no fixed sender (each mail's own, like
  // ZeptoMail) and its own sandbox flag. Same webhook token, so one webhook URL serves both.
  if (names.has('brevo'))
    providers.set(
      'brevo',
      createBrevoProvider({
        apiKey: s.BREVO_API_KEY!,
        apiBase: s.BREVO_API_BASE ?? 'https://api.brevo.com',
        webhookToken: s.BREVO_WEBHOOK_TOKEN,
        sandbox: s.BREVO_TRANSACTIONAL_SANDBOX ?? false,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
    );
  return providers;
}

/**
 * The one provider announcements go through: Brevo when its key and sender are set, else the
 * pretend inbox on a copy that has one (never production), else none, and then announcements
 * can't be sent. Never the provider other mail uses: announcements must not fall back to it.
 */
export function announcementMailProvider(
  s: MailSettings,
  mockSink: (mail: OutgoingMail) => Promise<void>,
): MailProvider | null {
  if (partial(s, BREVO_KEYS)?.length === 0)
    return createBrevoProvider({
      apiKey: s.BREVO_API_KEY!,
      apiBase: s.BREVO_API_BASE ?? 'https://api.brevo.com',
      fromAddress: s.ANNOUNCEMENT_FROM_ADDRESS!,
      webhookToken: s.BREVO_WEBHOOK_TOKEN,
      sandbox: s.BREVO_SANDBOX ?? false,
    });
  return isProduction(s) ? null : createMockMailProvider(mockSink);
}
