import { z } from 'zod';
import { createMockMailProvider } from './mock/provider.js';
import type {
  MailProvider,
  MailProviderName,
  OutgoingMail,
} from './provider.js';
import { createSesProvider } from './ses/provider.js';
import { createZeptoMailProvider } from './zeptomail/provider.js';

/**
 * Mail settings shared by the API (webhooks, tests, status) and the worker (sending). Secrets
 * are never logged and never appear in configuration errors, which name keys only.
 */
export const mailSettingsShape = {
  // Sends until staff choose a provider in ops. mock is refused in production.
  MAIL_DEFAULT_PROVIDER: z.enum(['mock', 'zeptomail', 'ses']).default('mock'),
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
}

const ZEPTO_KEYS = [
  'ZEPTOMAIL_API_KEY',
  'ZEPTOMAIL_API_BASE',
  'ZEPTOMAIL_WEBHOOK_KEY',
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
  return providers;
}
