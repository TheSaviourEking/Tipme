import {
  BUSINESS_NOTE_TAGS,
  BUSINESS_NOTIFICATION_KINDS,
  ISSUE_KINDS,
  ISSUE_OUTCOMES,
  OPS_PERMISSIONS,
  type OpsPermission,
  type OpsIssueKind as IssueKind,
  type OpsIssueSeverity as IssueSeverity,
  type OpsIssueSubject as IssueSubject,
} from '@tipme/contracts';
import {
  ATTEMPT_STATUSES,
  PAYOUT_STATUSES,
  SHARE_OPTIONS_BPS,
  TIP_STATUSES,
} from '@tipme/domain';
import { MAIL_CATEGORIES } from '@tipme/mail';
import type { SocialLink } from '@tipme/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// Money is bigint minor units (mode 'bigint' keeps it a JS bigint) plus an ISO 4217 currency.
const minor = (name: string) => bigint(name, { mode: 'bigint' });
const currency = () => char('currency', { length: 3 }).notNull();
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const currencyCheck = (table: string) =>
  check(`${table}_currency_iso`, sql`currency ~ '^[A-Z]{3}$'`);

export const tipStatus = pgEnum('tip_status', TIP_STATUSES);
export const attemptStatus = pgEnum('attempt_status', ATTEMPT_STATUSES);
export const providerEnvironment = pgEnum('provider_environment', [
  'sandbox',
  'live',
]);
export const paymentAccountStatus = pgEnum('payment_account_status', [
  'CREATING',
  'UNKNOWN',
  'ONBOARDING',
  'ACTIVE',
  'RESTRICTED',
  'FAILED',
]);
export const payoutStatus = pgEnum('payout_status', PAYOUT_STATUSES);
export const profileVisibility = pgEnum('profile_visibility', [
  'public',
  'hidden',
]);
export const profileStatus = pgEnum('profile_status', ['active', 'suspended']);
export const entityType = pgEnum('entity_type', [
  'tip',
  'attempt',
  'payout',
  // Paid Pro (ADR-0015).
  'pro_purchase',
  // A staff refund of a card-paid Pro month (plan Task 9, ruling 6).
  'pro_refund',
]);
export const transitionCause = pgEnum('transition_cause', [
  'provider_event',
  'system',
  'expiry',
  'staff',
]);
export const accountKind = pgEnum('account_kind', [
  'asset',
  'liability',
  'revenue',
  'expense',
]);
export const ledgerSide = pgEnum('ledger_side', ['debit', 'credit']);
export const operationType = pgEnum('operation_type', [
  'payment',
  'payout',
  'reward',
  // Business release 2: a refund or chargeback taking back every line of a tip's payment (R2-A).
  'reversal',
  // Paid Pro (ADR-0015): a Pro month bought on TipMe's own account. Never a tip.
  'pro_sale',
  // Paid Pro: a card month refunded by the partner (refund.paid), taken back out of Pro revenue.
  'pro_refund',
  // A refund whose fee TipMe returns keeps the processing TipMe recovered from the tip (owner,
  // 14 Nov 2026): the person bears it, so their payable is debited and TipMe keeps the recovery.
  'refund_processing',
]);

/** Auth subject and contact details arrive with ADR-0003. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    status: text('status').notNull().default('active'),
    // E.164 phone number: the identity. Nulled when the account is deleted (PR-008).
    phoneE164: text('phone_e164').unique(),
    email: text('email'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    // A second address, for getting back in if the sign-in email is lost.
    recoveryEmail: text('recovery_email'),
    recoveryEmailVerifiedAt: timestamp('recovery_email_verified_at', {
      withTimezone: true,
    }),
    // When the sign-in address last moved. Bank changes wait after it (BANK_CHANGE_HOLD_MS).
    emailChangedAt: timestamp('email_changed_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    // A proven address belongs to one live account; it is the sign-in identity.
    uniqueIndex('users_verified_email')
      .on(sql`lower(${table.email})`)
      .where(sql`email_verified_at IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex('users_verified_recovery_email')
      .on(sql`lower(${table.recoveryEmail})`)
      .where(
        sql`recovery_email_verified_at IS NOT NULL AND deleted_at IS NULL`,
      ),
  ],
);

/**
 * Moving an account to a new sign-in email when the old one is lost. It takes effect 24 hours
 * after the new address is proven, so the owner can still stop it.
 */
export const emailRecoveries = pgTable(
  'email_recoveries',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    newEmail: text('new_email').notNull(),
    startedBy: text('started_by').notNull(),
    staffUserId: uuid('staff_user_id'),
    // Filled when the new address is proven; the hold runs from here.
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    effectiveAt: timestamp('effective_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('email_recoveries_started_by', sql`started_by IN ('self', 'staff')`),
    index('email_recoveries_user').on(table.userId),
    index('email_recoveries_due')
      .on(table.effectiveAt)
      .where(sql`completed_at IS NULL AND cancelled_at IS NULL`),
  ],
);

/**
 * One-time codes sent by email, stored only as an HMAC. Only the latest unused code for an
 * address and purpose counts. Kept apart from phone codes, which return with phone sign-in.
 */
export const emailCodes = pgTable(
  'email_codes',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    codeHmac: text('code_hmac').notNull(),
    purpose: text('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      'email_codes_purpose',
      sql`purpose IN ('sign_in', 'email_change', 'recovery_email', 'recovery', 'recovery_new_email', 'payout_destination')`,
    ),
    index('email_codes_email_created').on(table.email, table.createdAt),
  ],
);

/** Wrong-code counting and lockouts, per address. */
export const emailCodeLockouts = pgTable('email_code_lockouts', {
  email: text('email').primaryKey(),
  failures: integer('failures').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});

/** One-time sign-in codes, stored only as an HMAC. Only the latest unused code for a number counts. */
export const signInCodes = pgTable(
  'sign_in_codes',
  {
    id: uuid('id').primaryKey(),
    phoneE164: text('phone_e164').notNull(),
    codeHmac: text('code_hmac').notNull(),
    purpose: text('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('sign_in_codes_purpose', sql`purpose IN ('sign_in', 'change_phone')`),
    index('sign_in_codes_phone_created').on(table.phoneE164, table.createdAt),
  ],
);

/** Wrong-code counting and lockouts, per phone number. */
export const signInLockouts = pgTable('sign_in_lockouts', {
  phoneE164: text('phone_e164').primaryKey(),
  failures: integer('failures').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});

/** Recipient sessions. Only the SHA-256 of the cookie token is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenSha256: text('token_sha256').notNull().unique(),
    deviceLabel: text('device_label').notNull().default(''),
    // SHA-256 of a long-lived browser cookie, to notice sign-ins from a new device.
    deviceHash: text('device_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('sessions_user').on(table.userId)],
);

/**
 * What the pretend messenger and mailbox "sent" (development only): there is no real delivery
 * until a messaging provider is approved. Holds codes and links, so it is never logged.
 */
export const pretendOutbox = pgTable(
  'pretend_outbox',
  {
    id: uuid('id').primaryKey(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    channel: text('channel').notNull(),
    recipientHint: text('recipient_hint').notNull(),
    userId: uuid('user_id'),
    subject: text('subject'),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  () => [
    check(
      'pretend_outbox_channel',
      sql`channel IN ('whatsapp', 'sms', 'email')`,
    ),
  ],
);

// ---- Mail (mail platform spec, 30 Oct 2026) ----

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(', ')})`);

export const MAIL_MESSAGE_STATUSES = [
  'queued',
  'sending',
  'sent',
  'failed',
  'suppressed',
  'skipped',
  'expired',
  'bounced',
  'complained',
] as const;
export type MailMessageStatus = (typeof MAIL_MESSAGE_STATUSES)[number];

export const MAIL_EVENT_KINDS = [
  'queued',
  'sent',
  'send_failed',
  'delivered',
  'opened',
  'clicked',
  'soft_bounce',
  'hard_bounce',
  'complaint',
  'suppressed',
  'skipped_preference',
  'expired',
] as const;
export type MailEventKindRecorded = (typeof MAIL_EVENT_KINDS)[number];

/**
 * Every email TipMe sends, queued in the transaction that causes it and sent by the worker.
 * The address, template data and snapshot are sealed (AES-256-GCM); only `to_hint` is readable.
 * Sealed address and data are wiped 7 days after a final status; the rest is kept 2 years.
 */
export const mailMessages = pgTable(
  'mail_messages',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    category: text('category').notNull(),
    userId: uuid('user_id').references(() => users.id),
    dedupeKey: text('dedupe_key').notNull().unique(),
    toSealed: text('to_sealed'),
    toHint: text('to_hint').notNull(),
    dataSealed: text('data_sealed'),
    renderedSealed: text('rendered_sealed'),
    status: text('status').notNull().default('queued'),
    // 0 security, 1 account, 2 everything else: codes never wait behind a broadcast.
    priority: integer('priority').notNull(),
    pinnedProvider: text('pinned_provider'),
    provider: text('provider'),
    providerMessageId: text('provider_message_id'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
    }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    lastError: text('last_error'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    finalAt: timestamp('final_at', { withTimezone: true }),
  },
  (table) => [
    check('mail_messages_category', inList('category', MAIL_CATEGORIES)),
    check('mail_messages_status', inList('status', MAIL_MESSAGE_STATUSES)),
    index('mail_messages_due').on(
      table.status,
      table.priority,
      table.nextAttemptAt,
    ),
    index('mail_messages_created').on(table.createdAt),
    index('mail_messages_type_created').on(table.type, table.createdAt),
    index('mail_messages_user_created').on(table.userId, table.createdAt),
    index('mail_messages_provider_id').on(
      table.provider,
      table.providerMessageId,
    ),
  ],
);

/** Append-only history of each email (tracking and audit). Normalised fields only. */
export const mailMessageEvents = pgTable(
  'mail_message_events',
  {
    id: uuid('id').primaryKey(),
    messageId: uuid('message_id').references(() => mailMessages.id),
    kind: text('kind').notNull(),
    provider: text('provider'),
    providerEventId: text('provider_event_id'),
    linkKey: text('link_key'),
    // Set on bounces, so repeated soft bounces to one address can be counted (no plain address).
    addressHmac: text('address_hmac'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: createdAt(),
  },
  (table) => [
    check('mail_message_events_kind', inList('kind', MAIL_EVENT_KINDS)),
    uniqueIndex('mail_message_events_provider_event')
      .on(table.provider, table.providerEventId)
      .where(sql`provider_event_id IS NOT NULL`),
    index('mail_message_events_message').on(table.messageId, table.occurredAt),
    index('mail_message_events_occurred').on(table.occurredAt),
    index('mail_message_events_address')
      .on(table.addressHmac, table.kind, table.occurredAt)
      .where(sql`address_hmac IS NOT NULL`),
  ],
);

/** Counts per Lagos day, type and provider, so month views stay fast at volume. Rebuildable. */
export const mailDailyStats = pgTable(
  'mail_daily_stats',
  {
    lagosDate: date('lagos_date').notNull(),
    type: text('type').notNull(),
    category: text('category').notNull(),
    // '' before a provider was chosen (queued).
    provider: text('provider').notNull(),
    kind: text('kind').notNull(),
    count: integer('count').notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [
        table.lagosDate,
        table.type,
        table.category,
        table.provider,
        table.kind,
      ],
    }),
  ],
);

/** Addresses TipMe no longer emails, keyed by an HMAC so the list holds no plain addresses. */
export const mailSuppressions = pgTable(
  'mail_suppressions',
  {
    addressHmac: text('address_hmac').primaryKey(),
    reason: text('reason').notNull(),
    provider: text('provider'),
    note: text('note'),
    createdAt: createdAt(),
  },
  () => [
    check(
      'mail_suppressions_reason',
      sql`reason IN ('hard_bounce', 'complaint', 'repeated_soft_bounce', 'manual')`,
    ),
  ],
);

/** Category switches (engagement on by default; marketing opt-in only). */
export const mailPreferences = pgTable('mail_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  engagement: boolean('engagement').notNull().default(true),
  marketing: boolean('marketing').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The provider staff chose for a kind of traffic; no row means the server default. Shared with
 * payment provider switching, which adds its state to `state` and `detail`.
 */
export const providerSettings = pgTable(
  'provider_settings',
  {
    kind: text('kind').primaryKey(),
    activeProvider: text('active_provider').notNull(),
    state: text('state').notNull().default('stable'),
    changedBy: uuid('changed_by'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    detail: jsonb('detail').notNull().default({}),
  },
  () => [check('provider_settings_kind', sql`kind IN ('mail', 'payment')`)],
);

/** A staff test of a provider. Only a hash of the confirmation token is kept. */
export const providerTests = pgTable(
  'provider_tests',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
    startedBy: uuid('started_by').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    targetHint: text('target_hint'),
    tokenSha256: text('token_sha256').unique(),
    status: text('status').notNull().default('pending'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    messageId: uuid('message_id').references(() => mailMessages.id),
    tipId: uuid('tip_id'),
  },
  (table) => [
    check('provider_tests_kind', sql`kind IN ('mail', 'payment')`),
    check(
      'provider_tests_status',
      sql`status IN ('pending', 'confirmed', 'failed', 'expired')`,
    ),
    index('provider_tests_recent').on(
      table.kind,
      table.provider,
      table.startedAt,
    ),
  ],
);

/** An account pinned to a provider other than the system one. Set by staff, always audited. */
export const providerOverrides = pgTable(
  'provider_overrides',
  {
    kind: text('kind').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    provider: text('provider').notNull(),
    setBy: uuid('set_by').notNull(),
    reason: text('reason').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.userId] }),
    check('provider_overrides_kind', sql`kind IN ('mail', 'payment')`),
  ],
);

export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id').primaryKey(),
    // One page per account (PR-008).
    userId: uuid('user_id')
      .references(() => users.id)
      .unique(),
    handle: text('handle').notNull(),
    handleLower: text('handle_lower').notNull().unique(),
    displayName: text('display_name').notNull(),
    bio: text('bio'),
    visibility: profileVisibility('visibility').notNull().default('public'),
    // TipMe-controlled (suspension, PR-009); page_state is the recipient's own switch.
    status: profileStatus('status').notNull().default('active'),
    // Why TipMe suspended the page (shown to the recipient); null unless suspended.
    suspendedReason: text('suspended_reason'),
    // A page created by the release check (PR-010): kept out of every total, list and dashboard.
    rehearsalRunId: uuid('rehearsal_run_id'),
    pageState: text('page_state').notNull().default('not_live'),
    role: text('role'),
    craft: text('craft'),
    note: text('note'),
    avatarPath: text('avatar_path'),
    // The three fixed links of before 5 Nov 2026. No longer read or written: `links` replaced it
    // (migration 0072 copied it across); kept until a later release drops it.
    socials: jsonb('socials')
      .$type<{ facebook?: string; instagram?: string; x?: string }>()
      .notNull()
      .default({}),
    // Every link the owner saved, in their order (@tipme/contracts socialLinksSchema). What shows
    // depends on the plan (visibleLinks): a lapsed Pro page keeps its extras here, hidden.
    links: jsonb('links').$type<SocialLink[]>().notNull().default([]),
    bioPublic: boolean('bio_public').notNull().default(true),
    socialsPublic: boolean('socials_public').notNull().default(true),
    phonePublic: boolean('phone_public').notNull().default(false),
    emailPublic: boolean('email_public').notNull().default(false),
    qrStyle: text('qr_style').notNull().default('purple'),
    // The page's photo version (PR-013): only ever goes up, so a photo URL is never reused, not
    // even after removing a photo and adding another.
    avatarVersion: integer('avatar_version').notNull().default(0),
    // The page's cover. A chosen design and colour from the catalogue (@tipme/contracts), held
    // as text so that removing a catalogue entry needs no migration; `coverPath` is an uploaded
    // photo, which wins over them. `coverVersion` only ever goes up, like `avatarVersion`.
    coverDesign: text('cover_design'),
    coverColour: text('cover_colour'),
    // An animated cover (owner's decision, 2 Nov 2026): an id from COVER_ANIMATIONS, held as text
    // like `coverDesign`. It wins over `coverDesign`; null `coverMotion` means it plays once.
    coverAnimation: text('cover_animation'),
    coverMotion: text('cover_motion'),
    coverPath: text('cover_path'),
    coverVersion: integer('cover_version').notNull().default(0),
    // When the page first went live (PR-013): `profile_published` is recorded once, ever.
    firstPublishedAt: timestamp('first_published_at', { withTimezone: true }),
    // Notification preferences (PR-013): what the recipient chose not to be told about.
    notifyTipEmails: boolean('notify_tip_emails').notNull().default(true),
    notifyWeeklyReports: boolean('notify_weekly_reports')
      .notNull()
      .default(true),
    notifyMilestones: boolean('notify_milestones').notNull().default(true),
    // Live updates (owner's ruling, 3 Nov 2026): "Hide who tipped and how much in pop-ups" (shared
    // screens, shop counters), and "Sound for new tips" in a background tab. Per account.
    popupHideTipDetails: boolean('popup_hide_tip_details')
      .notNull()
      .default(false),
    tipSound: boolean('tip_sound').notNull().default(true),
    // Free or Pro (PR-012). Staff set it; there is no billing while money is pretend.
    plan: text('plan').notNull().default('free'),
    // Paid Pro (ADR-0015): Pro granted by staff, apart from paid months. `plan` is what every Pro
    // check reads; recomputePlan derives it from this and the pro_periods that cover now.
    staffPro: boolean('staff_pro').notNull().default(false),
    // A Pro page's own tip amounts (kobo), kept when the page goes back to Free.
    tipPresetsMinor: bigint('tip_presets_minor', { mode: 'bigint' }).array(),
    minTipMinor: minor('min_tip_minor'),
    // The preset a Pro page's tip form starts on ("Make it yours"); NULL starts on the closest to
    // ₦2,000. Kept when the page goes back to Free, used again if it returns to Pro.
    tipStartMinor: minor('tip_start_minor'),
    // TipMe's share for this account in basis points, set by staff (ADR-0014); null = the policy's.
    customFeeBps: integer('custom_fee_bps'),
    // Handle changes made so far (never reset), and how many staff have allowed beyond the
    // standard allowance, at most MAX_HANDLE_CHANGE_EXTRA. Only Pro pages can make one.
    handleChangesUsed: integer('handle_changes_used').notNull().default(0),
    handleChangesExtra: integer('handle_changes_extra').notNull().default(0),
    // The thank-you line on the supporter's receipt ("Make it yours"), up to 140 characters. The
    // card style (NULL reads as paper) and the signature are Pro; a page that leaves Pro keeps them.
    thanksLine: text('thanks_line'),
    thanksStyle: text('thanks_style'),
    thanksSigned: boolean('thanks_signed').notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'profiles_page_state',
      sql`page_state IN ('live', 'not_live', 'deleted')`,
    ),
    check('profiles_plan', sql`plan IN ('free', 'pro')`),
    check('profiles_cover_motion', sql`cover_motion IN ('once', 'loop')`),
    check(
      'profiles_handle_changes',
      sql`handle_changes_used >= 0 AND handle_changes_extra BETWEEN 0 AND 20`,
    ),
    check(
      'profiles_custom_fee_bps',
      sql`custom_fee_bps IS NULL OR custom_fee_bps BETWEEN 0 AND 10000`,
    ),
    // Admin search by handle prefix (PR-013); the unique index cannot serve LIKE 'x%'.
    index('profiles_handle_prefix').on(
      table.handleLower.op('text_pattern_ops'),
    ),
    // Amounts in whole naira (no maximum); 1 to 4 presets. The ₦2,000 floor is the app's
    // (FEE_POLICY_V1): this older ₦1,000 check stays so rows saved under it remain valid.
    check(
      'profiles_min_tip',
      sql`min_tip_minor IS NULL OR (min_tip_minor >= 100000 AND min_tip_minor % 100 = 0)`,
    ),
    check(
      'profiles_tip_presets',
      sql`tip_presets_minor IS NULL OR cardinality(tip_presets_minor) BETWEEN 1 AND 4`,
    ),
    // Set together, and every preset at least the page's minimum.
    check(
      'profiles_tip_amounts_together',
      sql`(tip_presets_minor IS NULL) = (min_tip_minor IS NULL)`,
    ),
    check(
      'profiles_tip_presets_range',
      sql`tip_presets_minor IS NULL OR min_tip_minor <= ALL (tip_presets_minor)`,
    ),
    // The start is one of the page's own presets. `= ANY (NULL)` is NULL, which a CHECK lets
    // through, hence the coalesce: no own amounts means no start.
    check(
      'profiles_tip_start_in_presets',
      sql`tip_start_minor IS NULL OR coalesce(tip_start_minor = ANY (tip_presets_minor), false)`,
    ),
    // char_length counts code points, as THANKS_LINE_LIMIT does, so an emoji counts once.
    check(
      'profiles_thanks_line_length',
      sql`thanks_line IS NULL OR char_length(thanks_line) BETWEEN 1 AND 140`,
    ),
    check(
      'profiles_thanks_style',
      sql`thanks_style IS NULL OR thanks_style IN ('paper', 'violet', 'night')`,
    ),
  ],
);

/** Provider-owned recipient account references and normalized readiness only; no KYC payloads. */
export const paymentAccounts = pgTable(
  'payment_accounts',
  {
    id: uuid('id').primaryKey(),
    // A person's account, or (business release 2, R2-B) a business's: exactly one of the two.
    profileId: uuid('profile_id').references(() => profiles.id),
    businessId: uuid('business_id').references(() => businesses.id),
    provider: text('provider').notNull(),
    environment: providerEnvironment('environment').notNull(),
    providerAccountReference: text('provider_account_reference'),
    status: paymentAccountStatus('status').notNull(),
    chargesEnabled: boolean('charges_enabled').notNull().default(false),
    payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
    feeCollector: text('fee_collector').notNull().default('unknown'),
    requirementsDue: text('requirements_due')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    // Withdrawals for this account are paid by hand on a schedule, not by the provider's own.
    manualPayoutsAt: timestamp('manual_payouts_at', { withTimezone: true }),
    // When the payout capabilities were asked of the provider for an account made before them.
    payoutCapabilitiesRequestedAt: timestamp(
      'payout_capabilities_requested_at',
      {
        withTimezone: true,
      },
    ),
    // The last try at either step above, so a sweep cut short starts with the accounts it missed.
    payoutSetupAttemptedAt: timestamp('payout_setup_attempted_at', {
      withTimezone: true,
    }),
    // Business release 2, option B: a business's account only receives (payouts and transfers,
    // the partner's recipient persona) and never takes card payments, so it is ACTIVE without
    // charges_enabled. Only a business's account can be one.
    receiveOnly: boolean('receive_only').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('payment_accounts_profile_provider_environment').on(
      table.profileId,
      table.provider,
      table.environment,
    ),
    unique('payment_accounts_business_provider_environment').on(
      table.businessId,
      table.provider,
      table.environment,
    ),
    check(
      'payment_accounts_owner',
      sql`(profile_id IS NULL) <> (business_id IS NULL)`,
    ),
    unique('payment_accounts_provider_environment_reference').on(
      table.provider,
      table.environment,
      table.providerAccountReference,
    ),
    check(
      'payment_accounts_fee_collector',
      sql`fee_collector IN ('platform', 'connected_account', 'unknown')`,
    ),
    check(
      'payment_accounts_requirements_bound',
      sql`cardinality(requirements_due) <= 50`,
    ),
    check(
      'payment_accounts_active_can_charge',
      sql`status <> 'ACTIVE' OR charges_enabled OR receive_only`,
    ),
    check(
      'payment_accounts_receive_only_business',
      sql`NOT receive_only OR business_id IS NOT NULL`,
    ),
  ],
);

/** In-app notifications for recipients (tip confirmed, weekly report, moment). */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    tipId: uuid('tip_id'),
    momentId: uuid('moment_id'),
    reportId: uuid('report_id'),
    // TipMe for businesses: the invitation (business_invitation) or the business (business_verified).
    invitationId: uuid('invitation_id').references(
      () => businessInvitations.id,
    ),
    businessId: uuid('business_id').references(() => businesses.id),
    title: text('title').notNull(),
    body: text('body').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'notifications_kind',
      sql`kind IN ('tip', 'weekly_report', 'moment', ${sql.raw(BUSINESS_NOTIFICATION_KINDS.map((k) => `'${k}'`).join(', '))})`,
    ),
    // One notification per invitation, however often B3's write is retried.
    uniqueIndex('notifications_invitation_once')
      .on(table.kind, table.invitationId)
      .where(sql`invitation_id IS NOT NULL`),
    // One notification per confirmed tip, even when the outbox event is delivered twice.
    uniqueIndex('notifications_tip_once')
      .on(table.kind, table.tipId)
      .where(sql`tip_id IS NOT NULL`),
    index('notifications_user_created').on(table.userId, table.createdAt),
  ],
);

/** Surprise moments (milestones, best week/month, a lovely note). The key makes each one unique. */
export const moments = pgTable(
  'moments',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    key: text('key').notNull().unique(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    // Private until the recipient shares it on their page.
    sharedAt: timestamp('shared_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index('moments_profile_created').on(table.profileId, table.createdAt),
  ],
);

/** Fee-free tips a recipient has left. */
export const feeFreeCredits = pgTable(
  'fee_free_credits',
  {
    profileId: uuid('profile_id')
      .primaryKey()
      .references(() => profiles.id),
    remaining: integer('remaining').notNull().default(0),
  },
  () => [check('fee_free_credits_not_negative', sql`remaining >= 0`)],
);

/** What a moment gave: fee-free tips and/or cash (cash is also a `reward` ledger transaction). */
export const rewardGrants = pgTable('reward_grants', {
  id: uuid('id').primaryKey(),
  momentId: uuid('moment_id')
    .notNull()
    .unique()
    .references(() => moments.id),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id),
  kind: text('kind').notNull(),
  feeFreeCount: integer('fee_free_count').notNull().default(0),
  cashMinor: minor('cash_minor')
    .notNull()
    .default(sql`0`),
  createdAt: createdAt(),
});

/** Cash rewards paid per calendar month (Lagos), against the configured monthly budget. */
export const rewardBudget = pgTable('reward_budget', {
  month: text('month').primaryKey(),
  spentMinor: minor('spent_minor')
    .notNull()
    .default(sql`0`),
});

/** One weekly summary per recipient per ISO week (Lagos time). */
export const weeklyReports = pgTable(
  'weekly_reports',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    isoWeek: text('iso_week').notNull(),
    data: jsonb('data').notNull(),
    createdAt: createdAt(),
  },
  (table) => [unique('weekly_reports_once').on(table.profileId, table.isoWeek)],
);

/**
 * Account recovery by email waits 24 hours before a new number is attached, and the owner can
 * cancel it meanwhile: a hijacked mailbox alone never takes an account over at once.
 */
export const phoneRecoveries = pgTable(
  'phone_recoveries',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    newPhoneE164: text('new_phone_e164').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index('phone_recoveries_phone').on(table.newPhoneE164)],
);

/** Email verification and recovery links; only the token's SHA-256 is stored. */
export const emailTokens = pgTable(
  'email_tokens',
  {
    tokenSha256: text('token_sha256').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    email: text('email').notNull(),
    purpose: text('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  () => [check('email_tokens_purpose', sql`purpose IN ('verify', 'recover')`)],
);

/** Handles of deleted pages, held so nobody can immediately pose as the old owner. */
export const handleHolds = pgTable('handle_holds', {
  handleLower: text('handle_lower').primaryKey(),
  until: timestamp('until', { withTimezone: true }).notNull(),
});

/**
 * A page's previous handles (PR-011): they keep pointing at the page so printed QR codes still
 * work, and nobody else can claim them. Their number is bounded by the page's handle changes (the
 * Pro allowance plus what staff allowed); released as 90-day holds on deletion.
 */
export const handleAliases = pgTable(
  'handle_aliases',
  {
    handleLower: text('handle_lower').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    createdAt: createdAt(),
  },
  (table) => [index('handle_aliases_profile').on(table.profileId)],
);

/**
 * Usernames staff have reserved, on top of the built-in list in @tipme/domain (which stays in code
 * because the router depends on it). `handle_lower` is the reservationKey. Released rows stay as
 * history; at most one row per name is active. Triggers (migration 0072) keep a page or an old
 * username off an active reservation, and a reservation off a name a page holds.
 */
export const handleReservations = pgTable(
  'handle_reservations',
  {
    id: uuid('id').primaryKey(),
    handleLower: text('handle_lower').notNull(),
    source: text('source').notNull(),
    // The take-back this came from.
    takeBackId: uuid('take_back_id').references(() => handleTakeBacks.id),
    reason: text('reason').notNull(),
    // Null only when the system completed a take-back.
    reservedBy: uuid('reserved_by').references(() => users.id),
    reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by').references(() => users.id),
    releaseReason: text('release_reason'),
  },
  (table) => [
    uniqueIndex('handle_reservations_active')
      .on(table.handleLower)
      .where(sql`released_at IS NULL`),
    check(
      'handle_reservations_source',
      sql`${table.source} IN ('staff', 'take_back')`,
    ),
    check(
      'handle_reservations_released',
      sql`${table.releasedAt} IS NULL OR (${table.releasedBy} IS NOT NULL AND ${table.releaseReason} IS NOT NULL)`,
    ),
  ],
);

/**
 * Usernames TipMe takes back from a page (username reservation spec, section 3.3). One row per
 * take-back: approved (the notice is queued), noticed (a sent email or a seen banner started the
 * clock), due, then done or cancelled. The reason is staff-only; the user only ever reads the
 * category's fixed words, so there is no free text for them here (owner answer 3).
 */
export const handleTakeBacks = pgTable(
  'handle_take_backs',
  {
    id: uuid('id').primaryKey(),
    approvalRequestId: uuid('approval_request_id').references(
      () => approvalRequests.id,
    ),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    handleLower: text('handle_lower').notNull(),
    kind: text('kind').notNull(),
    category: text('category').notNull(),
    noticeDays: integer('notice_days').notNull(),
    reason: text('reason').notNull(),
    state: text('state').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    // Null when it ran alone, without a second person.
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
    noticedAt: timestamp('noticed_at', { withTimezone: true }),
    noticedVia: text('noticed_via'),
    bannerSeenAt: timestamp('banner_seen_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    noticeMailId: uuid('notice_mail_id').references(() => mailMessages.id),
    outcome: text('outcome'),
    newHandle: text('new_handle'),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancelReason: text('cancel_reason'),
    freeChangeUntil: timestamp('free_change_until', { withTimezone: true }),
    freeChangeUsedAt: timestamp('free_change_used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('handle_take_backs_open')
      .on(table.handleLower)
      .where(sql`state IN ('approved', 'noticed', 'due')`),
    index('handle_take_backs_open_profile')
      .on(table.profileId)
      .where(sql`state IN ('approved', 'noticed', 'due')`),
    index('handle_take_backs_state_due').on(table.state, table.dueAt),
    check('handle_take_backs_kind', sql`${table.kind} IN ('current', 'old')`),
    check(
      'handle_take_backs_category',
      sql`${table.category} IN ('ordinary', 'impersonation', 'trademark', 'legal')`,
    ),
    check(
      'handle_take_backs_notice_days',
      sql`(${table.category} = 'ordinary' AND ${table.noticeDays} BETWEEN 7 AND 30) OR (${table.category} <> 'ordinary' AND ${table.noticeDays} BETWEEN 0 AND 7)`,
    ),
    check(
      'handle_take_backs_state',
      sql`${table.state} IN ('approved', 'noticed', 'due', 'done', 'cancelled')`,
    ),
    check(
      'handle_take_backs_noticed_via',
      sql`${table.noticedVia} IS NULL OR ${table.noticedVia} IN ('email', 'banner', 'unreached')`,
    ),
    check(
      'handle_take_backs_outcome',
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('user_chose', 'assigned', 'page_deleted', 'old_removed')`,
    ),
  ],
);

export const tipQuotes = pgTable(
  'tip_quotes',
  {
    id: uuid('id').primaryKey(),
    // A person's tip, or (business release 2, R2-D) a team tip at a location: exactly one.
    profileId: uuid('profile_id').references(() => profiles.id),
    teamLocationId: uuid('team_location_id').references(
      () => businessLocations.id,
    ),
    currency: currency(),
    tipMinor: minor('tip_minor').notNull(),
    platformFeeMinor: minor('platform_fee_minor').notNull(),
    providerFeeMinor: minor('provider_fee_minor').notNull(),
    payerTotalMinor: minor('payer_total_minor').notNull(),
    recipientNetMinor: minor('recipient_net_minor').notNull(),
    feePolicyVersion: text('fee_policy_version').notNull(),
    // TipMe's fee that a fee-free reward waived on this quote (counts towards the reward cap).
    waivedPlatformFeeMinor: minor('waived_platform_fee_minor')
      .notNull()
      .default(sql`0`),
    // Business release 2 (R2-C2): the share agreement the supporter was shown on this quote, if
    // any. The intent fixes a share only when the one in force then is this same agreement.
    shareAgreementId: uuid('share_agreement_id').references(
      () => shareAgreements.id,
    ),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  () => [
    currencyCheck('tip_quotes'),
    check(
      'tip_quotes_recipient',
      sql`(profile_id IS NULL) <> (team_location_id IS NULL)`,
    ),
    check(
      'tip_quotes_amounts',
      sql`tip_minor > 0 AND platform_fee_minor >= 0 AND provider_fee_minor >= 0 AND recipient_net_minor > 0`,
    ),
    check('tip_quotes_payer_total', sql`payer_total_minor = tip_minor`),
    check(
      'tip_quotes_net',
      sql`recipient_net_minor = tip_minor - platform_fee_minor - provider_fee_minor`,
    ),
  ],
);

export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: uuid('id').primaryKey(),
    // One quote funds exactly one tip.
    quoteId: uuid('quote_id')
      .notNull()
      .unique()
      .references(() => tipQuotes.id),
    profileId: uuid('profile_id').references(() => profiles.id),
    teamLocationId: uuid('team_location_id').references(
      () => businessLocations.id,
    ),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    status: tipStatus('status').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('payment_intents_idempotency').on(
      table.profileId,
      table.idempotencyKey,
    ),
    unique('payment_intents_team_idempotency').on(
      table.teamLocationId,
      table.idempotencyKey,
    ),
    check(
      'payment_intents_recipient',
      sql`(profile_id IS NULL) <> (team_location_id IS NULL)`,
    ),
  ],
);

export const tips = pgTable(
  'tips',
  {
    id: uuid('id').primaryKey(),
    intentId: uuid('intent_id')
      .notNull()
      .unique()
      .references(() => paymentIntents.id),
    // The person tipped, or (business release 2, R2-D) null for a team tip, which names the
    // location instead and is split in team_tip_splits.
    profileId: uuid('profile_id').references(() => profiles.id),
    teamLocationId: uuid('team_location_id').references(
      () => businessLocations.id,
    ),
    currency: currency(),
    grossMinor: minor('gross_minor').notNull(),
    status: tipStatus('status').notNull(),
    payerDisplayLabel: text('payer_display_label'),
    purpose: text('purpose'),
    // Started from a recipient's shared celebration ("add to the celebration").
    celebrationMomentId: uuid('celebration_moment_id'),
    // Where the tip was made (TipMe for businesses): a label the server chose and checked at intent
    // time, never a destination. No posting reads it; the tip credits profile_id as every tip does.
    businessMemberId: uuid('business_member_id').references(
      () => businessMembers.id,
    ),
    businessLocationId: uuid('business_location_id').references(
      () => businessLocations.id,
    ),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    currencyCheck('tips'),
    check(
      'tips_business_pair',
      sql`(business_member_id IS NULL) = (business_location_id IS NULL)`,
    ),
    check(
      'tips_recipient',
      sql`(profile_id IS NULL) <> (team_location_id IS NULL)`,
    ),
    // A team tip is made to the location, never through one member.
    check(
      'tips_team_no_member',
      sql`team_location_id IS NULL OR business_member_id IS NULL`,
    ),
    index('tips_team_location_created')
      .on(table.teamLocationId, table.createdAt)
      .where(sql`team_location_id IS NOT NULL`),
    index('tips_business_location_completed')
      .on(table.businessLocationId, table.completedAt)
      .where(sql`business_location_id IS NOT NULL`),
    index('tips_business_member')
      .on(table.businessMemberId)
      .where(sql`business_member_id IS NOT NULL`),
    check('tips_gross_positive', sql`gross_minor > 0`),
    check(
      'tips_label_length',
      sql`payer_display_label IS NULL OR char_length(payer_display_label) <= 60`,
    ),
    check(
      'tips_purpose_known',
      sql`purpose IS NULL OR purpose IN ('thank_you', 'great_service', 'helped_me', 'celebration', 'gift', 'other')`,
    ),
    index('tips_profile_created').on(table.profileId, table.createdAt),
  ],
);

/** Payer free text, kept apart so it can get stricter access and retention. Never copied elsewhere. */
export const tipMessages = pgTable(
  'tip_messages',
  {
    tipId: uuid('tip_id')
      .primaryKey()
      .references(() => tips.id),
    body: text('body').notNull(),
    // The supporter ticked "may show this note on their page". Consent belongs to the note; only
    // notes written after this column existed can ever be true.
    mayShow: boolean('may_show').notNull().default(false),
    createdAt: createdAt(),
  },
  () => [
    check('tip_messages_length', sql`char_length(body) BETWEEN 1 AND 280`),
  ],
);

export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: uuid('id').primaryKey(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => paymentIntents.id),
    attemptNumber: integer('attempt_number').notNull(),
    provider: text('provider'),
    providerReference: text('provider_reference'),
    status: attemptStatus('status').notNull(),
    // When reconciliation last asked the provider; least-recently-checked goes first (no starvation).
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
    // Set before an external create call so concurrent requests cannot start a second checkout.
    startClaimedAt: timestamp('start_claimed_at', { withTimezone: true }),
    // When a provider read first showed the money taken while its details (who bore the fee)
    // were not final: the receipt says the payment went through. Not an outcome; nothing is booked.
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    unique('payment_attempts_number').on(table.intentId, table.attemptNumber),
    unique('payment_attempts_provider_reference').on(
      table.provider,
      table.providerReference,
    ),
    // Admin search (PR-013): a whole reference, or the 6-character ending staff see.
    index('payment_attempts_reference').on(table.providerReference),
    index('payment_attempts_reference_end').on(
      sql`lower(right(${table.providerReference}, 6))`,
    ),
  ],
);

export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey(),
    // A person's withdrawal, or (business release 2, R2-B) a business's: exactly one of the two.
    profileId: uuid('profile_id').references(() => profiles.id),
    businessId: uuid('business_id').references(() => businesses.id),
    currency: currency(),
    amountMinor: minor('amount_minor').notNull(),
    status: payoutStatus('status').notNull(),
    provider: text('provider'),
    providerReference: text('provider_reference'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    // SHA-256 of the profile and sorted tip IDs: a reused key with a different request is a conflict.
    requestFingerprint: text('request_fingerprint').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    // When reconciliation last asked the provider about this payout (fair rotation).
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
    destinationId: uuid('destination_id').references(
      () => payoutDestinations.id,
    ),
    // The provider's fee for this payout, in minor units of the payout currency.
    feeMinor: minor('fee_minor'),
    feeTransferReference: text('fee_transfer_reference'),
    // Who pays the partner's fee, fixed at request (owner, 12 Nov 2026): 'user' takes it from the
    // amount chosen (amount_minor is what is sent; user_fee_minor comes off the payable too); 'tipme'
    // tops the account up (every payout before the rule, and one that spends an unused top-up).
    feePayer: text('fee_payer').notNull().default('tipme'),
    // What the user was charged for the fee, never changed by what the partner later reports.
    userFeeMinor: bigint('user_fee_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    // Written and committed before any provider write. The attempt that set it clears it only on a
    // definite answer of its own; an outcome learned later by a read leaves it as evidence. While it
    // is set the payout is looked up, never sent again.
    startUncertainAt: timestamp('start_uncertain_at', { withTimezone: true }),
    // The provider call about to be made ('fee' or 'payout'), committed before it: staff need to know
    // whether the payout itself may have left.
    startStep: text('start_step'),
    // Set when the provider definitely refused TipMe itself (empty reserve, refused key) on the last
    // try. Nothing moved and nothing is in doubt: the payout waits to be queued again, and the time
    // also keys its next top-up, since a provider may replay a refused key for good.
    platformWaitSince: timestamp('platform_wait_since', { withTimezone: true }),
    // While the provider itself is checking this payout; the recipient is told so.
    providerReviewAt: timestamp('provider_review_at', { withTimezone: true }),
    // The provider's connected account the payout was requested on, recorded at request time.
    accountReference: text('account_reference'),
    createdAt: createdAt(),
  },
  (table) => [
    currencyCheck('payouts'),
    check('payouts_amount_positive', sql`amount_minor > 0`),
    check('payouts_owner', sql`(profile_id IS NULL) <> (business_id IS NULL)`),
    index('payouts_business_created')
      .on(table.businessId, table.createdAt.desc(), table.id.desc())
      .where(sql`business_id IS NOT NULL`),
    check('payouts_fee_not_negative', sql`fee_minor IS NULL OR fee_minor >= 0`),
    check('payouts_fee_payer', sql`fee_payer IN ('tipme', 'user')`),
    check(
      'payouts_user_fee',
      sql`user_fee_minor >= 0 AND (fee_payer = 'user' OR user_fee_minor = 0)`,
    ),
    check(
      'payouts_start_step',
      sql`start_step IS NULL OR start_step IN ('fee', 'payout')`,
    ),
    unique('payouts_provider_reference').on(
      table.provider,
      table.providerReference,
    ),
    // Admin search (PR-013).
    index('payouts_reference').on(table.providerReference),
    index('payouts_reference_end').on(
      sql`lower(right(${table.providerReference}, 6))`,
    ),
    // A recipient's withdrawals, newest request first (the dashboard's list and its cursor).
    index('payouts_profile_created').on(
      table.profileId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
);

/** A tip's net can be in only one active payout; a failed payout deactivates its items. */
export const payoutItems = pgTable(
  'payout_items',
  {
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => payouts.id),
    tipId: uuid('tip_id')
      .notNull()
      .references(() => tips.id),
    active: boolean('active').notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.payoutId, table.tipId] }),
    uniqueIndex('payout_items_active_tip')
      .on(table.tipId)
      .where(sql`active`),
  ],
);

/**
 * The bank account a recipient's withdrawals go to, as the provider holds it. Only the bank and
 * the last four digits are kept: never the full account number. `provider` is the stored name
 * ('bachs' for both environments), not an adapter name such as 'bachs-live'.
 */
export const payoutDestinations = pgTable(
  'payout_destinations',
  {
    id: uuid('id').primaryKey(),
    // A person's bank, or (business release 2, R2-B) a business's: exactly one of the two.
    profileId: uuid('profile_id').references(() => profiles.id),
    businessId: uuid('business_id').references(() => businesses.id),
    provider: text('provider').notNull(),
    destinationReference: text('destination_reference').notNull(),
    bankCode: text('bank_code').notNull(),
    bankName: text('bank_name').notNull(),
    accountLast4: char('account_last4', { length: 4 }).notNull(),
    status: text('status').notNull(),
    createdAt: createdAt(),
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'payout_destinations_status',
      sql`status IN ('usable', 'pending_review', 'rejected')`,
    ),
    check('payout_destinations_last4', sql`account_last4 ~ '^[0-9]{4}$'`),
    check('payout_destinations_provider', sql`provider ~ '^[a-z][a-z0-9_]*$'`),
    uniqueIndex('payout_destinations_active')
      .on(table.profileId, table.provider)
      .where(sql`replaced_at IS NULL`),
    uniqueIndex('payout_destinations_business_active')
      .on(table.businessId, table.provider)
      .where(sql`replaced_at IS NULL AND business_id IS NOT NULL`),
    check(
      'payout_destinations_owner',
      sql`(profile_id IS NULL) <> (business_id IS NULL)`,
    ),
  ],
);

/** A reason a recipient cannot withdraw until staff look at the linked issue. */
export const withdrawalHolds = pgTable(
  'withdrawal_holds',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    reason: text('reason').notNull(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id),
    createdAt: createdAt(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by'),
  },
  (table) => [
    check(
      'withdrawal_holds_reason',
      sql`reason IN ('reversal', 'in_debt', 'unexpected_payout', 'account_takeover')`,
    ),
    check(
      'withdrawal_holds_release',
      sql`released_by IS NULL OR released_at IS NOT NULL`,
    ),
    index('withdrawal_holds_active')
      .on(table.profileId)
      .where(sql`released_at IS NULL`),
  ],
);

/** Fee top-ups sent to a connected account and not yet spent on a payout's fee. */
export const providerFeeCredits = pgTable(
  'provider_fee_credits',
  {
    accountReference: text('account_reference').notNull(),
    provider: text('provider').notNull(),
    currency: currency(),
    amountMinor: minor('amount_minor').notNull(),
    transferReference: text('transfer_reference').primaryKey(),
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => payouts.id),
    usedByPayoutId: uuid('used_by_payout_id').references(() => payouts.id),
    createdAt: createdAt(),
  },
  (table) => [
    currencyCheck('provider_fee_credits'),
    check('provider_fee_credits_amount_positive', sql`amount_minor > 0`),
    check('provider_fee_credits_provider', sql`provider ~ '^[a-z][a-z0-9_]*$'`),
    index('provider_fee_credits_unspent')
      .on(table.accountReference, table.provider)
      .where(sql`used_by_payout_id IS NULL`),
  ],
);

/** Stored only once verified; the raw payload is restricted operational data. */
export const providerEvents = pgTable(
  'provider_events',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    signatureVerified: boolean('signature_verified').notNull(),
    payloadHash: text('payload_hash').notNull(),
    payload: jsonb('payload').notNull(),
    attemptId: uuid('attempt_id').references(() => paymentAttempts.id),
    payoutId: uuid('payout_id').references(() => payouts.id),
    // Paid Pro (ADR-0015): an event about a Pro purchase on TipMe's own account.
    proPurchaseId: uuid('pro_purchase_id').references(
      (): AnyPgColumn => proPurchases.id,
    ),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingOutcome: text('processing_outcome'),
  },
  (table) => [
    unique('provider_events_provider_event').on(
      table.provider,
      table.providerEventId,
    ),
    check('provider_events_verified', sql`signature_verified`),
  ],
);

/** Append-only history of every status change (enforced by trigger). */
export const statusTransitions = pgTable(
  'status_transitions',
  {
    id: uuid('id').primaryKey(),
    entityType: entityType('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    cause: transitionCause('cause').notNull(),
    providerEventId: uuid('provider_event_id').references(
      () => providerEvents.id,
    ),
    traceId: text('trace_id'),
    createdAt: createdAt(),
  },
  (table) => [
    index('status_transitions_entity').on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
  ],
);

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    kind: accountKind('kind').notNull(),
    currency: currency(),
    profileId: uuid('profile_id').references(() => profiles.id),
    // Business release 2: a business's own payable (`business_payable`), never a person's.
    businessId: uuid('business_id').references(() => businesses.id),
  },
  (table) => [
    currencyCheck('ledger_accounts'),
    // NULLS NOT DISTINCT: global accounts (no profile, no business) are unique per code and
    // currency too. Adding business_id keeps every existing row's identity (it is null on them).
    unique('ledger_accounts_identity')
      .on(table.code, table.currency, table.profileId, table.businessId)
      .nullsNotDistinct(),
    check(
      'ledger_accounts_one_owner',
      sql`profile_id IS NULL OR business_id IS NULL`,
    ),
    // Only a business holds a business_payable, and a business holds nothing else.
    check(
      'ledger_accounts_business_payable',
      sql`(code = 'business_payable') = (business_id IS NOT NULL)`,
    ),
  ],
);

/** One per business operation (unique operation key). Append-only. */
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: uuid('id').primaryKey(),
    operationType: operationType('operation_type').notNull(),
    operationKey: text('operation_key').notNull().unique(),
    currency: currency(),
    tipId: uuid('tip_id').references(() => tips.id),
    payoutId: uuid('payout_id').references(() => payouts.id),
    // Paid Pro (ADR-0015): the purchase a `pro_sale` books.
    proPurchaseId: uuid('pro_purchase_id').references(
      (): AnyPgColumn => proPurchases.id,
    ),
    // Business release 2 (R2-A): a reversal names the payment it takes back. The database checks
    // that it is the same tip's payment, in its currency, and at commit that all reversals of a
    // payment mirror it and take back at most what it put on each account (a refund and a later
    // chargeback are two events). The unique operation key (`reversal.<providerEventId>`) makes a
    // repeat of one event a no-op.
    reversesTransactionId: uuid('reverses_transaction_id').references(
      (): AnyPgColumn => ledgerTransactions.id,
    ),
    traceId: text('trace_id'),
    postedAt: timestamp('posted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    currencyCheck('ledger_transactions'),
    // Admin search (PR-013): a tip's or a payout's ledger entries.
    index('ledger_transactions_tip').on(table.tipId),
    index('ledger_transactions_payout').on(table.payoutId),
    index('ledger_transactions_reverses')
      .on(table.reversesTransactionId)
      .where(sql`reverses_transaction_id IS NOT NULL`),
    // Cast to text: the enum value is new in this migration and can't be used in it otherwise.
    check(
      'ledger_transactions_reversal',
      sql`(operation_type::text = 'reversal') = (reverses_transaction_id IS NOT NULL)`,
    ),
  ],
);

/** Append-only; balanced per transaction at commit (deferred constraint trigger). */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    profileId: uuid('profile_id'),
    // Business release 2: the business of a business_payable entry, as profile_id is the person's.
    // The database checks it matches the account.
    businessId: uuid('business_id'),
    side: ledgerSide('side').notNull(),
    amountMinor: minor('amount_minor').notNull(),
    currency: currency(),
    createdAt: createdAt(),
  },
  (table) => [
    currencyCheck('ledger_entries'),
    check('ledger_entries_amount_positive', sql`amount_minor > 0`),
    index('ledger_entries_transaction').on(table.transactionId),
    index('ledger_entries_account').on(table.accountId),
    index('ledger_entries_business')
      .on(table.businessId)
      .where(sql`business_id IS NOT NULL`),
  ],
);

/** Written in the same transaction as the state change; delivered by the worker relay. */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    eventType: text('event_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    payload: jsonb('payload').notNull(),
    trace: jsonb('trace').notNull(),
    createdAt: createdAt(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
  },
  (table) => [
    index('outbox_events_unpublished')
      .on(table.createdAt)
      .where(sql`published_at IS NULL`),
    check('outbox_events_dedupe_key', sql`dedupe_key !~ ':'`),
  ],
);

/** Verified provider messages that match no known attempt or payout; kept for review (append-only). */
export const unmatchedProviderEvents = pgTable(
  'unmatched_provider_events',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    payloadHash: text('payload_hash').notNull(),
    payload: jsonb('payload').notNull(),
    reason: text('reason').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('unmatched_provider_events_identity').on(
      table.provider,
      table.providerEventId,
    ),
  ],
);

/**
 * When reconciliation last tried a parked payout event (fair rotation). Its own table, because
 * unmatched_provider_events is append-only.
 */
export const parkedPayoutChecks = pgTable('parked_payout_checks', {
  // No foreign key: one would change how the append-only table refuses TRUNCATE.
  unmatchedId: uuid('unmatched_id').primaryKey(),
  lastCheckedAt: timestamp('last_checked_at', {
    withTimezone: true,
  }).notNull(),
});

/**
 * Staff's switch for all withdrawals, one row, read on every request and start so a change takes
 * effect at once with no deploy. Seeded on, with no change time; no row at all reads as off. Each change is audited.
 */
export const withdrawalsSwitch = pgTable(
  'withdrawals_switch',
  {
    id: text('id').primaryKey().default('global'),
    paused: boolean('paused').notNull(),
    changedBy: uuid('changed_by'),
    changedAt: timestamp('changed_at', { withTimezone: true }),
  },
  () => [check('withdrawals_switch_one_row', sql`id = 'global'`)],
);

/** Each time live payments changed on this copy: the API records one at boot. */
export const livePaymentSwitches = pgTable(
  'live_payment_switches',
  {
    id: uuid('id').primaryKey(),
    live: boolean('live').notNull(),
    provider: text('provider').notNull(),
    // The deployed commit, or `unknown` when a copy was started without one.
    version: text('version').notNull(),
    switchedAt: timestamp('switched_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('live_payment_switches_latest').on(
      table.switchedAt.desc(),
      table.id.desc(),
    ),
  ],
);

/**
 * One read of the platform's payment reserve (the balance that covers payout fees), taken every
 * 15 minutes by the worker. A read that failed has no amount: `available_minor` and `low` are then
 * both null ("unknown"), never a guess. `alerted_at` is when staff were told about this reading;
 * it is how an alert is told once per low spell and again every 6 hours, across restarts.
 * `provider` is the adapter name (bachs-live or bachs-sandbox), so sandbox readings never count
 * for live.
 */
export const paymentReserveReadings = pgTable(
  'payment_reserve_readings',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    currency: currency(),
    availableMinor: minor('available_minor'),
    thresholdMinor: minor('threshold_minor').notNull(),
    low: boolean('low'),
    readAt: timestamp('read_at', { withTimezone: true }).notNull(),
    alertedAt: timestamp('alerted_at', { withTimezone: true }),
    // Set while a worker is sending this reading's alert, cleared if the send fails. An old claim
    // with no `alerted_at` is a worker that died mid-send, so the alert is sent again.
    alertClaimedAt: timestamp('alert_claimed_at', { withTimezone: true }),
  },
  (table) => [
    currencyCheck('payment_reserve_readings'),
    check(
      'payment_reserve_readings_provider',
      sql`provider ~ '^[a-z][a-z0-9_-]*$'`,
    ),
    // Unknown is both null together; a known balance says low or not, matching the threshold.
    check(
      'payment_reserve_readings_known',
      sql`(available_minor IS NULL AND low IS NULL)
        OR (available_minor IS NOT NULL AND low IS NOT NULL AND low = (available_minor < threshold_minor))`,
    ),
    index('payment_reserve_readings_latest').on(
      table.provider,
      table.currency,
      table.readAt.desc(),
    ),
    index('payment_reserve_readings_read_at').on(table.readAt.desc()),
  ],
);

// ---- Staff access and audit (PR-009, ADR-0010) ----

// The list lives in @tipme/contracts (OPS_CATALOGUE) so every app reads one source.
export { OPS_PERMISSIONS };
export type { OpsPermission };

/**
 * A role is a named set of permissions, so new roles need no code change. `system` roles (`owner`,
 * `release_check`) can't be edited or deleted; the rest are generated ids, and names are unique
 * whatever their case.
 */
export const roles = pgTable(
  'roles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    system: boolean('system').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('roles_name_lower').on(sql`lower(${table.name})`)],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id),
    permission: text('permission').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permission] }),
    check(
      'role_permissions_known',
      sql`permission IN (${sql.raw(OPS_PERMISSIONS.map((p) => `'${p}'`).join(', '))})`,
    ),
  ],
);

/** Staff are recipients' accounts with a role. Granted only by `pnpm ops:grant-owner`. */
export const staff = pgTable('staff', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  roleId: text('role_id')
    .notNull()
    .references(() => roles.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // First confirmed an authenticator. Outlives losing it (a reset, grant-owner); only being granted
  // access again after removal clears it. Null is what makes someone a mere invitee.
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
});

/** A person's adjustments on top of their role; they stay when the role changes. */
export const staffPermissionOverrides = pgTable(
  'staff_permission_overrides',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    permission: text('permission').notNull(),
    effect: text('effect').notNull(),
    grantedBy: uuid('granted_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.permission] }),
    check(
      'staff_permission_overrides_known',
      sql`permission IN (${sql.raw(OPS_PERMISSIONS.map((p) => `'${p}'`).join(', '))})`,
    ),
    check(
      'staff_permission_overrides_effect',
      sql`effect IN ('add', 'remove')`,
    ),
  ],
);

/** One-time codes that allow registering an authenticator; only the SHA-256 is stored. */
export const staffEnrolments = pgTable('staff_enrolments', {
  codeSha256: text('code_sha256').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/** The authenticator secret, sealed with OPS_TOTP_KEY; `last_step` stops a code being used twice. */
export const staffTotp = pgTable('staff_totp', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  secretEnc: text('secret_enc').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  lastStep: bigint('last_step', { mode: 'bigint' }),
  createdAt: createdAt(),
});

/** An admin grant on top of a recipient session: 12 hours at most, 1 hour idle. */
export const opsSessions = pgTable(
  'ops_sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    tokenSha256: text('token_sha256').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // When an authenticator code was last entered for this grant; sensitive routes ask for a recent one.
    lastTotpAt: timestamp('last_totp_at', { withTimezone: true }),
  },
  (table) => [index('ops_sessions_user').on(table.userId)],
);

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'expired',
  'stale',
] as const;

/** A serious action waiting for a second person. It stores the action and what to run it with. */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey(),
    action: text('action').notNull(),
    payload: jsonb('payload').notNull(),
    // The action's `current` value when asked for: if it has moved at approval, the action stops.
    pinned: jsonb('pinned'),
    // Exactly what will change, in words, fixed when requested.
    summary: text('summary').notNull(),
    permission: text('permission').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedReason: text('decided_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'approval_requests_status',
      sql`status IN (${sql.raw(APPROVAL_STATUSES.map((s) => `'${s}'`).join(', '))})`,
    ),
    index('approval_requests_pending')
      .on(table.expiresAt)
      .where(sql`status = 'pending'`),
    index('approval_requests_created').on(table.createdAt),
  ],
);

export const opsLockouts = pgTable('ops_lockouts', {
  userId: uuid('user_id').primaryKey(),
  failures: integer('failures').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});

/** Who did what, to what, and why. Append-only (0017 triggers). `staff_user_id` null = system. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    staffUserId: uuid('staff_user_id'),
    action: text('action').notNull(),
    permission: text('permission'),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    reason: text('reason'),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('audit_events_seq').on(table.seq)],
);

// ---- Issues inbox (PR-009) ----

export { ISSUE_KINDS, ISSUE_OUTCOMES };
export type { IssueKind, IssueSeverity, IssueSubject };

/**
 * Something that needs a person. Opened once per cause (`dedupe_key`); resolved by staff or by the
 * system when the cause clears, and never reopened: a recurrence is a new issue.
 */
export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull().default('open'),
    subject: jsonb('subject').$type<IssueSubject>().notNull(),
    summary: text('summary').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    // 'system' or the staff user's id.
    resolvedBy: text('resolved_by'),
    // About a release-check page (PR-010): hidden from the default inbox.
    rehearsal: boolean('rehearsal').notNull().default(false),
    // How staff settled a money issue (with their reason, in the audit log); no balance changes.
    resolutionOutcome: text('resolution_outcome'),
    // A Pro member's support request (priority support): sorted first in the open queue.
    priority: boolean('priority').notNull().default(false),
  },
  (table) => [
    check(
      'issues_kind',
      sql`kind IN (${sql.raw(ISSUE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    ),
    check('issues_severity', sql`severity IN ('money', 'account', 'info')`),
    check('issues_status', sql`status IN ('open', 'resolved')`),
    check(
      'issues_resolution_outcome',
      sql`resolution_outcome IS NULL OR (status = 'resolved' AND resolution_outcome IN (${sql.raw(ISSUE_OUTCOMES.map((o) => `'${o}'`).join(', '))}))`,
    ),
    check(
      'issues_resolution',
      sql`(status = 'open') = (resolved_at IS NULL AND resolved_by IS NULL)`,
    ),
    index('issues_status_opened').on(table.status, table.openedAt),
  ],
);

/** Staff notes on an issue; append-only like the audit log. */
export const issueNotes = pgTable(
  'issue_notes',
  {
    id: uuid('id').primaryKey(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id),
    staffUserId: uuid('staff_user_id'),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check('issue_notes_length', sql`char_length(text) BETWEEN 1 AND 2000`),
    index('issue_notes_issue').on(table.issueId),
  ],
);

// ---- Anonymous analytics (PR-009, ADR-0010) ----

/**
 * Raw events, kept 90 days. No IP, user agent, URL, account or cross-session id: a per-tab flow id,
 * a minute bucket and a device class only. Server outcomes carry a dedupe key instead of a flow.
 */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: uuid('id').primaryKey(),
    atMinute: timestamp('at_minute', { withTimezone: true }).notNull(),
    name: text('name').notNull(),
    flowId: uuid('flow_id'),
    surface: text('surface'),
    channel: text('channel'),
    handle: text('handle'),
    returning: boolean('returning'),
    device: text('device'),
    dedupeKey: text('dedupe_key').unique(),
    // About a release-check page (PR-010): excluded from rollups and dashboards.
    rehearsal: boolean('rehearsal').notNull().default(false),
    // Campaign Studio: the running campaign the page was opened from (its id only, never who).
    campaignId: uuid('campaign_id'),
  },
  (table) => [
    check(
      'analytics_events_device',
      sql`device IS NULL OR device IN ('mobile', 'desktop')`,
    ),
    check(
      'analytics_events_minute',
      sql`at_minute = date_trunc('minute', at_minute)`,
    ),
    index('analytics_events_at').on(table.atMinute),
    index('analytics_events_campaign')
      .on(table.campaignId, table.atMinute)
      .where(sql`campaign_id IS NOT NULL`),
  ],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * A page's photo (PR-013): one per page, already re-encoded on the server (512×512 WebP, no
 * metadata), about 30 KB. Either in Postgres (`bytes`) or, when R2 is configured, in a private
 * R2 bucket (`object_key`); exactly one of the two. `version` changes with each upload, so the
 * URL can be cached for ever.
 */
export const profileAvatars = pgTable(
  'profile_avatars',
  {
    profileId: uuid('profile_id')
      .primaryKey()
      .references(() => profiles.id),
    version: integer('version').notNull(),
    bytes: bytea('bytes'),
    objectKey: text('object_key'),
    createdAt: createdAt(),
  },
  () => [
    check(
      'profile_avatars_one_place',
      sql`(bytes IS NULL) <> (object_key IS NULL)`,
    ),
  ],
);

/**
 * A page's uploaded cover: one per page, already re-encoded on the server (2240×600 WebP, no
 * metadata). Kept like `profile_avatars`: in Postgres or in R2, exactly one of the two.
 */
export const profileCovers = pgTable(
  'profile_covers',
  {
    profileId: uuid('profile_id')
      .primaryKey()
      .references(() => profiles.id),
    version: integer('version').notNull(),
    bytes: bytea('bytes'),
    objectKey: text('object_key'),
    createdAt: createdAt(),
  },
  () => [
    check(
      'profile_covers_one_place',
      sql`(bytes IS NULL) <> (object_key IS NULL)`,
    ),
  ],
);

/**
 * Visitors' reports of a page (PR-013): the page, a reason from a fixed list and the minute.
 * No IP, user agent or free text.
 */
export const profileReports = pgTable(
  'profile_reports',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    reason: text('reason').notNull(),
    atMinute: timestamp('at_minute', { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      'profile_reports_reason',
      sql`reason IN ('impersonation', 'scam', 'abusive', 'other')`,
    ),
    index('profile_reports_profile').on(table.profileId, table.atMinute),
  ],
);

/** Real-user web vitals (PR-011): metric, value, page kind and device class, nothing else. */
export const webVitals = pgTable(
  'web_vitals',
  {
    id: uuid('id').primaryKey(),
    atMinute: timestamp('at_minute', { withTimezone: true }).notNull(),
    metric: text('metric').notNull(),
    value: doublePrecision('value').notNull(),
    page: text('page').notNull(),
    device: text('device').notNull(),
  },
  (table) => [
    check(
      'web_vitals_metric',
      sql`metric IN ('LCP', 'INP', 'CLS', 'FCP', 'TTFB')`,
    ),
    check('web_vitals_device', sql`device IN ('mobile', 'desktop')`),
    check(
      'web_vitals_minute',
      sql`at_minute = date_trunc('minute', at_minute)`,
    ),
    index('web_vitals_at').on(table.atMinute),
  ],
);

/** Daily totals (Lagos days) that outlive the raw events. */
export const analyticsDaily = pgTable(
  'analytics_daily',
  {
    date: date('date', { mode: 'string' }).notNull(),
    metric: text('metric').notNull(),
    dimension: text('dimension').notNull().default(''),
    value: bigint('value', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.date, table.metric, table.dimension] }),
  ],
);

// ---- Market notes (PR-009) ----

/** Outside observations recorded by staff (competitor fees, mentions, ratings). Archived, never deleted. */
export const marketEntries = pgTable(
  'market_entries',
  {
    id: uuid('id').primaryKey(),
    observedOn: date('observed_on', { mode: 'string' }).notNull(),
    category: text('category').notNull(),
    name: text('name').notNull(),
    metric: text('metric').notNull(),
    value: numeric('value', { mode: 'number' }),
    text: text('text'),
    sourceUrl: text('source_url').notNull(),
    note: text('note'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'market_entries_category',
      sql`category IN ('competitor', 'social', 'app_store', 'press', 'other')`,
    ),
    check('market_entries_source_https', sql`source_url LIKE 'https://%'`),
    index('market_entries_series').on(
      table.name,
      table.metric,
      table.observedOn,
    ),
  ],
);

// ---- Release rehearsal (PR-010) ----

/** One full run of the release check. Its pages are tagged; nothing it booked is ever deleted. */
export const releaseRuns = pgTable('release_runs', {
  id: uuid('id').primaryKey(),
  createdAt: createdAt(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  issuesClosed: integer('issues_closed'),
});

// ---- Backups (PR-011) ----

/** Every finished backup (logical dump or physical base backup), for /health/backups and alerts. */
export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    file: text('file').notNull(),
    version: text('version').notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('backup_runs_kind', sql`kind IN ('logical', 'base')`),
    index('backup_runs_kind_finished').on(table.kind, table.finishedAt),
  ],
);

/**
 * Each run of the backup retention coordinator (staging's local Postgres): what it found, what it
 * would delete or deleted, and why it was blocked. Read by /health/backups and the watcher.
 */
export const backupRetentionRuns = pgTable(
  'backup_retention_runs',
  {
    id: uuid('id').primaryKey(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull(),
    mode: text('mode').notNull(),
    outcome: text('outcome').notNull(),
    /** Why pruning was blocked, one reason per line; empty when nothing blocked it. */
    blocked: text('blocked').notNull().default(''),
    retainedBackups: integer('retained_backups').notNull(),
    boundary: text('boundary'),
    archiveBytes: bigint('archive_bytes', { mode: 'bigint' }).notNull(),
    candidateBytes: bigint('candidate_bytes', { mode: 'bigint' }).notNull(),
    deletedBytes: bigint('deleted_bytes', { mode: 'bigint' }).notNull(),
    diskFreeBytes: bigint('disk_free_bytes', { mode: 'bigint' }).notNull(),
    diskTotalBytes: bigint('disk_total_bytes', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    check('backup_retention_runs_mode', sql`mode IN ('dry-run', 'apply')`),
    check(
      'backup_retention_runs_outcome',
      sql`outcome IN ('planned', 'applied', 'blocked', 'failed')`,
    ),
    index('backup_retention_runs_ran_at').on(table.ranAt),
  ],
);

/** Each recovery drill (pitr-drill.sh): pruning needs a recent pass. */
export const recoveryDrills = pgTable(
  'recovery_drills',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    baseFile: text('base_file'),
    passed: boolean('passed').notNull(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('recovery_drills_kind', sql`kind IN ('pitr')`),
    index('recovery_drills_ran_at').on(table.ranAt),
  ],
);

/** Written by the point-in-time-recovery drill just before it restores: proof nothing was lost. */
export const recoveryMarkers = pgTable('recovery_markers', {
  id: uuid('id').primaryKey(),
  createdAt: createdAt(),
});

/**
 * A recipient's choices about a supporter's message (PR-011): hidden from their own views, and
 * whether it was reported to TipMe. The message itself (tip_messages) is never changed.
 */
export const messageFlags = pgTable(
  'message_flags',
  {
    tipId: uuid('tip_id')
      .primaryKey()
      .references(() => tips.id),
    hiddenAt: timestamp('hidden_at', { withTimezone: true }).notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    reportReason: text('report_reason'),
  },
  () => [
    check(
      'message_flags_reason',
      sql`report_reason IS NULL OR report_reason IN ('abusive', 'spam', 'other')`,
    ),
  ],
);

/**
 * Repeat supporters (Pro additions, option (a)): a supporter who ticked "Let {recipient} recognise
 * me next time". One row per recipient and browser key; only the key's SHA-256 is stored, never
 * the key, and never a card, IP, device or browser fingerprint. Keys are per recipient, so these
 * rows cannot link one supporter's tips across recipients. Kept apart from the money tables:
 * deleting a row ("Stop {name} recognising me") never touches a tip.
 */
export const supporters = pgTable(
  'supporters',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    keyHash: bytea('key_hash').notNull(),
    // The name they typed most recently with this key (cleaned like tips.payer_display_label).
    label: text('label').notNull(),
    firstAt: timestamp('first_at', { withTimezone: true }).notNull(),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('supporters_key_hash_length', sql`octet_length(key_hash) = 32`),
    check('supporters_label_length', sql`char_length(label) BETWEEN 1 AND 60`),
    unique('supporters_profile_key').on(table.profileId, table.keyHash),
  ],
);

/** Which tips an opted-in supporter made. Unpaid rows are harmless: only paid tips are counted. */
export const tipSupporters = pgTable(
  'tip_supporters',
  {
    tipId: uuid('tip_id')
      .primaryKey()
      .references(() => tips.id),
    supporterId: uuid('supporter_id')
      .notNull()
      .references(() => supporters.id, { onDelete: 'cascade' }),
  },
  (table) => [index('tip_supporters_supporter').on(table.supporterId)],
);

// TipMe for businesses (plan docs/superpowers/plans/2026-11-06-business.md, PR B0). Release 1 moves
// no money: every table here is a label or a list beside today's tips, never a ledger input.

const BUSINESS_SLUG_RE = (max: number) =>
  `'^[a-z0-9](?:[a-z0-9-]{0,${max - 2}}[a-z0-9])?$'`;
const quotedList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

/** A business account: verified by TipMe staff before its codes go live. */
export const businesses = pgTable(
  'businesses',
  {
    id: uuid('id').primaryKey(),
    // Locked once verified (M7): printed codes are never reprinted.
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    status: text('status').notNull().default('pending'),
    contactName: text('contact_name').notNull(),
    contactEmail: text('contact_email').notNull(),
    contactPhone: text('contact_phone'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: uuid('verified_by').references(() => users.id),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendedReason: text('suspended_reason'),
    // The logo's served address (`/v1/business-logos/<id>/<n>.webp`), or null for the initial.
    // `logoVersion` only ever goes up, like a page's `avatarVersion`: a new logo is a new URL.
    logoPath: text('logo_path'),
    logoVersion: integer('logo_version').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    check('businesses_slug', sql`slug ~ ${sql.raw(BUSINESS_SLUG_RE(40))}`),
    check('businesses_name', sql`char_length(name) BETWEEN 1 AND 80`),
    check(
      'businesses_status',
      sql`status IN ('pending', 'verified', 'suspended')`,
    ),
    check(
      'businesses_contact',
      sql`char_length(contact_name) BETWEEN 1 AND 80 AND char_length(contact_email) BETWEEN 3 AND 254 AND (contact_phone IS NULL OR char_length(contact_phone) <= 32)`,
    ),
    check(
      'businesses_suspended',
      sql`(status = 'suspended') = (suspended_at IS NOT NULL) AND (suspended_at IS NULL OR suspended_reason IS NOT NULL)`,
    ),
    // A suspended business was verified first.
    check(
      'businesses_verified',
      sql`status = 'pending' OR verified_at IS NOT NULL`,
    ),
    index('businesses_created_by').on(table.createdBy),
    index('businesses_status_created').on(table.status, table.createdAt),
  ],
);

/**
 * A business's uploaded logo: one per business, re-encoded on the server (512×512 WebP, no
 * metadata) exactly like a page photo, and kept like `profile_avatars`: in Postgres or in R2,
 * exactly one of the two.
 */
export const businessLogos = pgTable(
  'business_logos',
  {
    businessId: uuid('business_id')
      .primaryKey()
      .references(() => businesses.id),
    version: integer('version').notNull(),
    bytes: bytea('bytes'),
    objectKey: text('object_key'),
    createdAt: createdAt(),
  },
  () => [
    check(
      'business_logos_one_place',
      sql`(bytes IS NULL) <> (object_key IS NULL)`,
    ),
  ],
);

export const businessLocations = pgTable(
  'business_locations',
  {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    address: text('address').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    unique('business_locations_slug').on(table.businessId, table.slug),
    check(
      'business_locations_slug_rule',
      sql`slug ~ ${sql.raw(BUSINESS_SLUG_RE(30))}`,
    ),
    check(
      'business_locations_text',
      sql`char_length(name) BETWEEN 1 AND 60 AND char_length(address) BETWEEN 1 AND 200`,
    ),
  ],
);

/** Owners manage every location; a location manager one. Removal keeps the row. */
export const businessManagers = pgTable(
  'business_managers',
  {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    locationId: uuid('location_id').references(() => businessLocations.id),
    addedBy: uuid('added_by').references(() => users.id),
    createdAt: createdAt(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (table) => [
    check('business_managers_role', sql`role IN ('owner', 'location_manager')`),
    check(
      'business_managers_location',
      sql`(role = 'owner') = (location_id IS NULL)`,
    ),
    uniqueIndex('business_managers_open')
      .on(table.businessId, table.userId)
      .where(sql`removed_at IS NULL`),
    index('business_managers_user')
      .on(table.userId)
      .where(sql`removed_at IS NULL`),
  ],
);

/** A staff member: one TipMe page at one location. A new row each time someone rejoins. */
export const businessMembers = pgTable(
  'business_members',
  {
    id: uuid('id').primaryKey(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => businessLocations.id),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    shownName: text('shown_name').notNull(),
    showPhoto: boolean('show_photo').notNull().default(true),
    shareAmounts: boolean('share_amounts').notNull().default(false),
    invitedBy: uuid('invited_by').references(() => users.id),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    leftBy: text('left_by'),
  },
  (table) => [
    check(
      'business_members_shown_name',
      sql`char_length(shown_name) BETWEEN 1 AND 30`,
    ),
    check(
      'business_members_left',
      sql`(left_at IS NULL) = (left_by IS NULL) AND (left_by IS NULL OR left_by IN ('self', 'manager', 'tipme', 'account_deleted'))`,
    ),
    uniqueIndex('business_members_open')
      .on(table.locationId, table.profileId)
      .where(sql`left_at IS NULL`),
    index('business_members_profile')
      .on(table.profileId)
      .where(sql`left_at IS NULL`),
  ],
);

/**
 * An invitation to join (staff) or help manage (manager). It reaches the person by email, a
 * one-time link, or a TipMe username (owner's answer, 6 Nov 2026). Only the code's hash is kept.
 */
export const businessInvitations = pgTable(
  'business_invitations',
  {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    locationId: uuid('location_id').references(() => businessLocations.id),
    kind: text('kind').notNull(),
    managerRole: text('manager_role'),
    target: text('target').notNull(),
    emailLower: text('email_lower'),
    invitedProfileId: uuid('invited_profile_id').references(() => profiles.id),
    codeSha256: text('code_sha256').notNull().unique(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    check('business_invitations_kind', sql`kind IN ('staff', 'manager')`),
    check(
      'business_invitations_target',
      sql`target IN ('email', 'link', 'user') AND (target = 'email') = (email_lower IS NOT NULL) AND (target = 'user') = (invited_profile_id IS NOT NULL)`,
    ),
    check(
      'business_invitations_role',
      sql`(kind = 'staff' AND manager_role IS NULL AND location_id IS NOT NULL) OR (kind = 'manager' AND manager_role IN ('owner', 'location_manager') AND (manager_role = 'owner') = (location_id IS NULL))`,
    ),
    check(
      'business_invitations_outcome',
      sql`(accepted_at IS NOT NULL)::int + (declined_at IS NOT NULL)::int + (revoked_at IS NOT NULL)::int <= 1 AND (accepted_at IS NULL) = (accepted_by IS NULL)`,
    ),
    index('business_invitations_business').on(
      table.businessId,
      table.createdAt,
    ),
    index('business_invitations_email')
      .on(table.emailLower)
      .where(sql`email_lower IS NOT NULL`),
    index('business_invitations_profile')
      .on(table.invitedProfileId)
      .where(sql`invited_profile_id IS NOT NULL`),
  ],
);

/** The invited person said no more invitations from this business (owner's answer, 6 Nov 2026). */
export const businessInvitationBlocks = pgTable(
  'business_invitation_blocks',
  {
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.businessId, table.userId] }),
    index('business_invitation_blocks_user').on(table.userId),
  ],
);

/** On shift at a location. Reads ignore an open row older than SHIFT_MAX_HOURS. */
export const businessShifts = pgTable(
  'business_shifts',
  {
    id: uuid('id').primaryKey(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => businessMembers.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    startedBy: text('started_by').notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: text('ended_by'),
  },
  (table) => [
    check('business_shifts_started_by', sql`started_by IN ('self', 'manager')`),
    check(
      'business_shifts_ended',
      sql`(ended_at IS NULL) = (ended_by IS NULL) AND (ended_by IS NULL OR ended_by IN ('self', 'manager', 'expired', 'left'))`,
    ),
    uniqueIndex('business_shifts_open')
      .on(table.memberId)
      .where(sql`ended_at IS NULL`),
    index('business_shifts_member_started').on(table.memberId, table.startedAt),
  ],
);

/**
 * What a supporter said about the person, after paying. Apart from tip_messages, which stay
 * private to the person. The member comes from the tip, never from the request.
 */
export const businessNotes = pgTable(
  'business_notes',
  {
    tipId: uuid('tip_id')
      .primaryKey()
      .references(() => tips.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => businessMembers.id),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    body: text('body'),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'business_notes_tags',
      sql`cardinality(tags) <= 5 AND tags <@ ARRAY[${quotedList(BUSINESS_NOTE_TAGS.map((tag) => tag.id))}]::text[]`,
    ),
    check(
      'business_notes_body',
      sql`body IS NULL OR char_length(body) BETWEEN 1 AND 280`,
    ),
    check(
      'business_notes_something',
      sql`cardinality(tags) > 0 OR body IS NOT NULL`,
    ),
    index('business_notes_member').on(table.memberId, table.createdAt),
  ],
);

/** A reported note is hidden from the business until TipMe staff review it. */
export const businessNoteFlags = pgTable(
  'business_note_flags',
  {
    tipId: uuid('tip_id')
      .primaryKey()
      .references(() => businessNotes.tipId),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull(),
    reportedBy: text('reported_by').notNull(),
    reason: text('reason').notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    outcome: text('outcome'),
  },
  () => [
    check(
      'business_note_flags_reported',
      sql`reported_by IN ('member', 'manager') AND reason IN ('abusive', 'spam', 'other')`,
    ),
    check(
      'business_note_flags_review',
      sql`(reviewed_at IS NULL) = (outcome IS NULL) AND (outcome IS NULL OR outcome IN ('restored', 'removed'))`,
    ),
  ],
);

// ---- Business release 2 (plan R2-0 Task 27; owner's report, 6 Nov 2026) ----

const SHARE_BPS_SQL = sql.raw(SHARE_OPTIONS_BPS.join(', '));
const SHARE_TAKEN_BPS_SQL = sql.raw(
  SHARE_OPTIONS_BPS.filter((bps) => bps > 0).join(', '),
);

/**
 * A split between a staff member and their business: what the business takes, in basis points of
 * what the person receives after TipMe's fee (Q9). One option of five, capped at 50%. It applies
 * only once accepted, from `effective_from` (at least 14 days after it was proposed), and only to
 * tips made at that membership. A declined one is never shown to the business as declined.
 */
export const shareAgreements = pgTable(
  'share_agreements',
  {
    id: uuid('id').primaryKey(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => businessMembers.id),
    businessBps: integer('business_bps').notNull(),
    proposedBy: text('proposed_by').notNull(),
    proposedByUser: uuid('proposed_by_user')
      .notNull()
      .references(() => users.id),
    // The database clock: a caller can't backdate it (the migration's trigger refuses an earlier
    // value), so the 14 days' notice is real.
    proposedAt: timestamp('proposed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    effectiveFrom: timestamp('effective_from', {
      withTimezone: true,
    }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    // Leaving the business ends it at once (M16).
    endedAt: timestamp('ended_at', { withTimezone: true }),
    // The accepted agreement that replaces this one from its own effective_from.
    supersededBy: uuid('superseded_by').references(
      (): AnyPgColumn => shareAgreements.id,
    ),
  },
  (table) => [
    check('share_agreements_bps', sql`business_bps IN (${SHARE_BPS_SQL})`),
    check(
      'share_agreements_proposed_by',
      sql`proposed_by IN ('business', 'member')`,
    ),
    check(
      'share_agreements_notice',
      sql`effective_from >= proposed_at + interval '14 days'`,
    ),
    check(
      'share_agreements_answer',
      sql`(accepted_at IS NOT NULL)::int + (declined_at IS NOT NULL)::int + (withdrawn_at IS NOT NULL)::int <= 1`,
    ),
    check(
      'share_agreements_ended',
      sql`(ended_at IS NULL AND superseded_by IS NULL) OR accepted_at IS NOT NULL`,
    ),
    // The newest accepted agreement, which may not have started yet: during its notice the one it
    // supersedes is still in force. "In force at a time" is tipme_share_agreement_at(member, at),
    // the same rule the share trigger uses; read the agreement through it, not through this index.
    uniqueIndex('share_agreements_latest_accepted')
      .on(table.memberId)
      .where(
        sql`accepted_at IS NOT NULL AND ended_at IS NULL AND superseded_by IS NULL`,
      ),
    uniqueIndex('share_agreements_open')
      .on(table.memberId)
      .where(
        sql`accepted_at IS NULL AND declined_at IS NULL AND withdrawn_at IS NULL`,
      ),
    index('share_agreements_member').on(table.memberId, table.effectiveFrom),
    // One successor replaces one agreement: agreements form a single ordered chain.
    uniqueIndex('share_agreements_one_predecessor')
      .on(table.supersededBy)
      .where(sql`superseded_by IS NOT NULL`),
  ],
);

/** A staff member's report about their business to TipMe. Never shown to the business. */
export const shareReports = pgTable(
  'share_reports',
  {
    id: uuid('id').primaryKey(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => businessMembers.id),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    reason: text('reason').notNull(),
    body: text('body'),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'share_reports_reason',
      sql`reason IN ('pressure', 'wrong_share', 'other')`,
    ),
    check(
      'share_reports_body',
      sql`body IS NULL OR char_length(body) BETWEEN 1 AND 280`,
    ),
    index('share_reports_business').on(table.businessId, table.createdAt),
    index('share_reports_member').on(table.memberId),
  ],
);

/**
 * The share fixed on a tip when it was made (R2-C2), never changed afterwards (append-only). The
 * database refuses a row unless the tip was made at that agreement's membership, after the
 * agreement was accepted and took effect, and the amount is exactly the share of the tip's net,
 * rounded down. A tip through the person's own page has no member and can never have one.
 */
export const tipBusinessShares = pgTable(
  'tip_business_shares',
  {
    tipId: uuid('tip_id')
      .primaryKey()
      .references(() => tips.id),
    agreementId: uuid('agreement_id')
      .notNull()
      .references(() => shareAgreements.id),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    businessBps: integer('business_bps').notNull(),
    shareMinor: minor('share_minor').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'tip_business_shares_bps',
      sql`business_bps IN (${SHARE_TAKEN_BPS_SQL})`,
    ),
    check('tip_business_shares_positive', sql`share_minor > 0`),
    index('tip_business_shares_business').on(table.businessId),
    index('tip_business_shares_agreement').on(table.agreementId),
  ],
);

/**
 * How a team tip's net was split (R2-D): equally among the people on shift at that location when
 * the tip was made, fixed then (append-only). The database checks each member is at the tip's
 * location and the person is that member's page.
 */
export const teamTipSplits = pgTable(
  'team_tip_splits',
  {
    tipId: uuid('tip_id')
      .notNull()
      .references(() => tips.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => businessMembers.id),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    amountMinor: minor('amount_minor').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tipId, table.memberId] }),
    check('team_tip_splits_positive', sql`amount_minor > 0`),
    index('team_tip_splits_profile').on(table.profileId),
  ],
);

/** A printed card for a table (R2-E, M18), opening `/b/<b>/<l>/t/<code>`. */
export const tableCards = pgTable(
  'table_cards',
  {
    id: uuid('id').primaryKey(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => businessLocations.id),
    label: text('label').notNull(),
    code: text('code').notNull().unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    check('table_cards_label', sql`char_length(label) BETWEEN 1 AND 20`),
    check('table_cards_code', sql`code ~ '^[a-z2-7]{10}$'`),
    index('table_cards_location').on(table.locationId),
  ],
);

/**
 * Who serves a table card for a shift. It ends with the shift. The database checks the member is
 * at the card's location and the shift is theirs.
 */
export const tableAssignments = pgTable(
  'table_assignments',
  {
    id: uuid('id').primaryKey(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => tableCards.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => businessMembers.id),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => businessShifts.id),
    assignedBy: uuid('assigned_by')
      .notNull()
      .references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('table_assignments_open')
      .on(table.cardId)
      .where(sql`ended_at IS NULL`),
    index('table_assignments_member').on(table.memberId),
    index('table_assignments_shift').on(table.shiftId),
  ],
);

/**
 * One entry per pull request merged into dev (changelog plan, 5 Nov 2026). Staff edit the working
 * copy (`user_text`, `audience`, each change bumping `revision`); users only ever read the
 * published copy, which an approval writes. The state (draft, approved, live, recorded, withdrawn)
 * is derived by `changelogState` in contracts, never stored. The PR body itself is never kept.
 */
export const changelogEntries = pgTable(
  'changelog_entries',
  {
    prNumber: integer('pr_number').primaryKey(),
    // What "reached production" is checked against, by git ancestry in the deploy job.
    mergeSha: text('merge_sha').notNull(),
    mergedAt: timestamp('merged_at', { withTimezone: true }).notNull(),
    // As received; admin only.
    prTitle: text('pr_title').notNull(),
    staffText: text('staff_text').notNull(),
    userText: text('user_text'),
    audience: text('audience').notNull(),
    revision: integer('revision').notNull().default(1),
    publishedText: text('published_text'),
    publishedAudience: text('published_audience'),
    publishedRevision: integer('published_revision'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id),
    // First time staging, then production, ran a commit containing merge_sha. live_at is never cleared.
    stagingAt: timestamp('staging_at', { withTimezone: true }),
    liveAt: timestamp('live_at', { withTimezone: true }),
    liveVersion: text('live_version'),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnBy: uuid('withdrawn_by').references(() => users.id),
    withdrawnReason: text('withdrawn_reason'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // What What's new lists, newest first.
    index('changelog_entries_user_list')
      .on(table.liveAt.desc(), table.prNumber.desc())
      .where(
        sql`${table.withdrawnAt} IS NULL AND ${table.publishedAudience} <> 'staff'`,
      ),
    index('changelog_entries_merged').on(table.mergedAt.desc()),
    // What the deploy sync asks about.
    index('changelog_entries_pending')
      .on(table.prNumber)
      .where(sql`${table.liveAt} IS NULL AND ${table.withdrawnAt} IS NULL`),
    check('changelog_entries_pr_number', sql`${table.prNumber} > 0`),
    check(
      'changelog_entries_merge_sha',
      sql`${table.mergeSha} ~ '^[0-9a-f]{40}$'`,
    ),
    check(
      'changelog_entries_pr_title',
      sql`char_length(${table.prTitle}) <= 256`,
    ),
    check(
      'changelog_entries_staff_text',
      sql`char_length(${table.staffText}) BETWEEN 1 AND 1000`,
    ),
    check(
      'changelog_entries_user_text',
      sql`${table.userText} IS NULL OR char_length(${table.userText}) BETWEEN 1 AND 280`,
    ),
    check(
      'changelog_entries_audience',
      sql`${table.audience} IN ('staff', 'everyone', 'pro', 'early_access')`,
    ),
    // Staff only exactly when there is no user text.
    check(
      'changelog_entries_audience_staff',
      sql`(${table.audience} = 'staff') = (${table.userText} IS NULL)`,
    ),
    check('changelog_entries_revision', sql`${table.revision} >= 1`),
    check(
      'changelog_entries_published_text',
      sql`${table.publishedText} IS NULL OR char_length(${table.publishedText}) BETWEEN 1 AND 280`,
    ),
    check(
      'changelog_entries_published_audience',
      sql`${table.publishedAudience} IS NULL OR ${table.publishedAudience} IN ('staff', 'everyone', 'pro', 'early_access')`,
    ),
    // A published copy is whole: its audience and revision together, with a text unless it is
    // staff only (a user text removed, then approved).
    check(
      'changelog_entries_published_together',
      sql`(${table.publishedAudience} IS NULL AND ${table.publishedRevision} IS NULL AND ${table.publishedText} IS NULL)
        OR (${table.publishedAudience} IS NOT NULL AND ${table.publishedRevision} IS NOT NULL
            AND (${table.publishedAudience} = 'staff') = (${table.publishedText} IS NULL))`,
    ),
    check(
      'changelog_entries_live_version',
      sql`${table.liveVersion} IS NULL OR ${table.liveVersion} ~ '^[0-9a-f]{12}$'`,
    ),
    check(
      'changelog_entries_withdrawn_together',
      sql`(${table.withdrawnAt} IS NULL AND ${table.withdrawnBy} IS NULL AND ${table.withdrawnReason} IS NULL)
        OR (${table.withdrawnAt} IS NOT NULL AND ${table.withdrawnBy} IS NOT NULL
            AND ${table.withdrawnReason} IS NOT NULL AND char_length(${table.withdrawnReason}) > 0)`,
    ),
  ],
);

/**
 * When each person last looked at What's new, so the dot and the Home slip show once per update on
 * any device. Its own table rather than a profiles column; deleteAccount removes the row.
 */
export const changelogReads = pgTable('changelog_reads', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  seenThrough: timestamp('seen_through', { withTimezone: true }).notNull(),
});

// ---- Paid Pro (ADR-0015; the owner's decisions of 4, 5 and 9 Nov 2026) ----

/**
 * Every Pro price ever set, append-only. The current price is the latest row whose
 * `effective_from` has passed. A purchase keeps the price it was opened at, so a change applies to
 * new months only. The launch row (₦2,500) is seeded by its migration with no `set_by`.
 */
export const proPrices = pgTable(
  'pro_prices',
  {
    id: uuid('id').primaryKey(),
    amountMinor: minor('amount_minor').notNull(),
    currency: currency(),
    effectiveFrom: timestamp('effective_from', {
      withTimezone: true,
    }).notNull(),
    setBy: uuid('set_by').references(() => users.id),
    approvedBy: uuid('approved_by').references(() => users.id),
    reason: text('reason').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('pro_prices_effective_from').on(table.effectiveFrom),
    check('pro_prices_amount_positive', sql`${table.amountMinor} > 0`),
    check('pro_prices_currency_ngn', sql`${table.currency} = 'NGN'`),
    check('pro_prices_reason', sql`char_length(${table.reason}) > 0`),
  ],
);

export const PRO_PERIOD_STATUSES = [
  'SCHEDULED',
  'ACTIVE',
  'GRACE',
  'ENDED',
] as const;
export const PRO_PAID_BY = [
  'card',
  'bank_transfer',
  'balance',
  'saved_card',
] as const;

/**
 * One paid month of Pro. It covers `starts_at` up to `grace_ends_at` (its end plus 3 days' grace).
 * One per payment (`purchase_id` unique), never two starting together, and at most one queued.
 * `status` follows the clock (the expiry job moves it); the plan itself is read from the times.
 */
export const proPeriods = pgTable(
  'pro_periods',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    // Null only for periods made in tests; every paid month has its purchase.
    purchaseId: uuid('purchase_id').unique(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    graceEndsAt: timestamp('grace_ends_at', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    paidBy: text('paid_by').notNull(),
    amountMinor: minor('amount_minor').notNull(),
    currency: currency(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('pro_periods_profile_start').on(table.profileId, table.startsAt),
    uniqueIndex('pro_periods_one_scheduled')
      .on(table.profileId)
      .where(sql`${table.status} = 'SCHEDULED'`),
    index('pro_periods_due').on(table.status, table.endsAt),
    check(
      'pro_periods_status',
      sql`${table.status} IN ('SCHEDULED', 'ACTIVE', 'GRACE', 'ENDED')`,
    ),
    check(
      'pro_periods_paid_by',
      sql`${table.paidBy} IN ('card', 'bank_transfer', 'balance', 'saved_card')`,
    ),
    check(
      'pro_periods_times',
      sql`${table.startsAt} < ${table.endsAt} AND ${table.endsAt} < ${table.graceEndsAt}`,
    ),
    check('pro_periods_amount_positive', sql`${table.amountMinor} > 0`),
    currencyCheck('pro_periods'),
  ],
);

/**
 * One Pro payment (ADR-0015): the price is fixed when it is opened, and the server is its only
 * source. Card or bank transfer happen on the partner's checkout (`method` 'card' covers both; the
 * month records which). At most one is open per page. Paid only from the partner's confirmed
 * payment, read back; booked once (`pro.<id>`) and starts one month once.
 */
export const proPurchases = pgTable(
  'pro_purchases',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    method: text('method').notNull(),
    priceId: uuid('price_id')
      .notNull()
      .references(() => proPrices.id),
    amountMinor: minor('amount_minor').notNull(),
    currency: currency(),
    status: text('status').notNull(),
    provider: text('provider'),
    providerReference: text('provider_reference'),
    // The partner's hosted page, so an open purchase can be resumed. Not a secret.
    checkoutUrl: text('checkout_url'),
    idempotencyKey: text('idempotency_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    // Set when TipMe claims the one partner create call for this purchase, before making it.
    startClaimedAt: timestamp('start_claimed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    // The partner's fee, from the read-back, once paid.
    feeMinor: minor('fee_minor'),
    // Paying from the balance (plan Task 8): the connected account the money is moved from.
    accountReference: text('account_reference'),
    // The partner's payment (charge) id, read back once paid: what a card refund names.
    chargeReference: text('charge_reference'),
    // Auto-renew (plan Task 10): the payer asked to save their card on this checkout.
    saveCard: boolean('save_card').notNull().default(false),
    // A saved-card renewal: the month it renews. One attempt per month, never a second.
    renewsPeriodId: uuid('renews_period_id').unique(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('pro_purchases_idempotency').on(
      table.profileId,
      table.idempotencyKey,
    ),
    uniqueIndex('pro_purchases_one_open')
      .on(table.profileId)
      .where(sql`${table.status} IN ('PENDING', 'COLLECTING', 'UNKNOWN')`),
    uniqueIndex('pro_purchases_provider_reference')
      .on(table.provider, table.providerReference)
      .where(sql`${table.providerReference} IS NOT NULL`),
    index('pro_purchases_open').on(table.status, table.createdAt),
    check(
      'pro_purchases_status',
      sql`${table.status} IN ('PENDING', 'COLLECTING', 'UNKNOWN', 'PAID', 'FAILED', 'EXPIRED', 'REVIEW')`,
    ),
    check(
      'pro_purchases_method',
      sql`${table.method} IN ('card', 'bank_transfer', 'balance', 'saved_card')`,
    ),
    check('pro_purchases_amount_positive', sql`${table.amountMinor} > 0`),
    check(
      'pro_purchases_fee',
      sql`${table.feeMinor} IS NULL OR (${table.feeMinor} >= 0 AND ${table.feeMinor} <= ${table.amountMinor})`,
    ),
    currencyCheck('pro_purchases'),
  ],
);

// ---- Pro insights: Campaign Studio, monthly recap, priority support (11 Nov 2026) ----

/**
 * A campaign (Campaign Studio, the ProCampaigns board): a named link `/@handle/<slug>` to the
 * normal tip page. Only a tracked link: no goal, target, end date or purpose. Stopping keeps its
 * results; its link keeps opening the page. Never deleted while the page exists.
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: createdAt(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
  },
  (table) => [
    unique('campaigns_profile_slug').on(table.profileId, table.slug),
    check('campaigns_name_length', sql`char_length(name) BETWEEN 1 AND 40`),
    check(
      'campaigns_slug_format',
      sql`slug ~ '^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$'`,
    ),
    index('campaigns_profile_active')
      .on(table.profileId)
      .where(sql`stopped_at IS NULL`),
  ],
);

/** Which campaign a tip was started from. A label beside the tip: no money table reads it. */
export const tipCampaigns = pgTable(
  'tip_campaigns',
  {
    tipId: uuid('tip_id')
      .primaryKey()
      .references(() => tips.id),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
  },
  (table) => [index('tip_campaigns_campaign').on(table.campaignId)],
);

/** One recap per Pro page and Lagos month, however often the monthly job runs. */
export const monthlyRecaps = pgTable(
  'monthly_recaps',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    month: text('month').notNull(),
    data: jsonb('data').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('monthly_recaps_once').on(table.profileId, table.month),
    check('monthly_recaps_month', sql`month ~ '^\\d{4}-(0[1-9]|1[0-2])$'`),
  ],
);

/**
 * A person's support request (priority support). Its words stay here, apart from the issue that
 * puts it in the ops queue; staff read them through the audited reveal. `priority` is the plan
 * when it was sent.
 */
export const supportRequests = pgTable(
  'support_requests',
  {
    id: uuid('id').primaryKey(),
    issueId: uuid('issue_id')
      .notNull()
      .unique()
      .references(() => issues.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    profileId: uuid('profile_id').references(() => profiles.id),
    topic: text('topic').notNull(),
    body: text('body').notNull(),
    priority: boolean('priority').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'support_requests_topic',
      sql`topic IN ('withdrawal', 'tip', 'page', 'account', 'pro', 'other')`,
    ),
    check(
      'support_requests_body_length',
      sql`char_length(body) BETWEEN 1 AND 2000`,
    ),
    index('support_requests_user').on(table.userId, table.createdAt),
  ],
);
export const PRO_REFUND_STATUSES = [
  'REQUESTED',
  'PROCESSING',
  'UNKNOWN',
  'PAID',
  'FAILED',
] as const;

/**
 * A staff refund of one card-paid Pro month (plan Task 9; ruling 6): asked on the member's request
 * within 14 days, decided by a second person, then sent to the partner once (idempotency key
 * `tipme-pro-refund-<id>`). Only `refund.paid` books it and ends the month; `refund.failed` changes
 * nothing about Pro and lets staff try again (the partner allows one refund per payment, and a
 * failed one doesn't count).
 */
export const proRefunds = pgTable(
  'pro_refunds',
  {
    id: uuid('id').primaryKey(),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => proPurchases.id),
    status: text('status').notNull(),
    amountMinor: minor('amount_minor').notNull(),
    currency: currency(),
    // The partner's refund id once known, and what its refund.paid said.
    providerRefundReference: text('provider_refund_reference'),
    refundedMinor: minor('refunded_minor'),
    refundFeeMinor: minor('refund_fee_minor'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    approvedBy: uuid('approved_by').references(() => users.id),
    reason: text('reason').notNull(),
    // Set when TipMe claims the partner call, before making it.
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One refund per payment, but a failed one doesn't count (the partner's refund guide).
    uniqueIndex('pro_refunds_one_per_purchase')
      .on(table.purchaseId)
      .where(sql`${table.status} <> 'FAILED'`),
    index('pro_refunds_open').on(table.status, table.createdAt),
    check(
      'pro_refunds_status',
      sql`${table.status} IN ('REQUESTED', 'PROCESSING', 'UNKNOWN', 'PAID', 'FAILED')`,
    ),
    check('pro_refunds_amount_positive', sql`${table.amountMinor} > 0`),
    currencyCheck('pro_refunds'),
  ],
);

/**
 * Auto-renew on a saved naira card (plan Task 10; ruling 9), behind PRO_AUTO_RENEW. Opted into at
 * purchase; the partner's ids only (no card details). Turning it off clears the saved method, so
 * nothing can be charged until the person opts in again on a new checkout.
 */
export const proAutoRenew = pgTable('pro_auto_renew', {
  profileId: uuid('profile_id')
    .primaryKey()
    .references(() => profiles.id),
  provider: text('provider').notNull(),
  enabled: boolean('enabled').notNull(),
  customerReference: text('customer_reference'),
  paymentMethodReference: text('payment_method_reference'),
  // The month whose renewal was refused: reminders and grace apply to it as usual.
  failedPeriodId: uuid('failed_period_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Business release 2, option B (owner, 11 Nov 2026): money TipMe moves between partner accounts for
 * a shared tip. The partner refuses a transfer between two accounts, so every movement goes through
 * TipMe's own balance in two legs: `out` (an account to TipMe, `destination: "self"`) and `in`
 * (TipMe to an account). Each leg has its own idempotency key (`tipme-share-out-<id>`,
 * `tipme-share-in-<id>`), is claimed here before the partner is asked, and an unknown answer is read
 * back, never sent blindly. The second leg starts only once the first is confirmed paid.
 *
 * - `sweep`: the business's share, staff -> TipMe -> business, once the tip's money is available.
 * - `recover`: a refunded tip's share the business still holds, business -> TipMe -> staff.
 * - `fee_return`: TipMe's fee on a refunded tip, TipMe -> the person tipped (no `out` leg). On
 *   every refunded tip once the refund is final (owner, 12 Nov 2026, behind REFUND_FEE_RETURN), and
 *   on a lost dispute staff reverse; once per partner refund or dispute (`partner_reversal_id`).
 * - `holdback_repay`: part of a later sweep held back from the business for a share it had already
 *   withdrawn, TipMe -> the staff member it is owed to (no `out` leg: the sweep brought it in).
 *
 * The ledger is unchanged by these moves: it records what each party is owed, and these only make
 * each partner balance match it.
 */
export const shareTransfers = pgTable(
  'share_transfers',
  {
    id: uuid('id').primaryKey(),
    tipId: uuid('tip_id')
      .notNull()
      .references(() => tips.id),
    kind: text('kind').notNull(),
    // Every kind but fee_return is about a business; a fee goes back on any tip.
    businessId: uuid('business_id').references(() => businesses.id),
    // The staff member the tip was for (sweep, recover, fee_return) or is owed (holdback_repay).
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    currency: currency(),
    // What the first leg moves (or, without one, what TipMe sends).
    amountMinor: minor('amount_minor').notNull(),
    // What the `in` leg sends, fixed once the `out` leg is confirmed: for a sweep, the share less
    // what is held back. Null until then.
    deliverMinor: minor('deliver_minor'),
    status: text('status').notNull(),
    provider: text('provider').notNull(),
    outReference: text('out_reference'),
    inReference: text('in_reference'),
    // recover: the reversal that asked for it (one per reversal).
    reversalTransactionId: uuid('reversal_transaction_id').references(
      () => ledgerTransactions.id,
    ),
    // fee_return: the partner's refund or dispute it answers (`refund.<id>`, `dispute.<id>`).
    partnerReversalId: text('partner_reversal_id'),
    // holdback_repay: the sweep that brought the money in, and the hold-back it pays.
    parentId: uuid('parent_id').references(
      (): AnyPgColumn => shareTransfers.id,
    ),
    holdbackId: uuid('holdback_id').references(
      (): AnyPgColumn => shareHoldbacks.id,
    ),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    currencyCheck('share_transfers'),
    check(
      'share_transfers_kind',
      sql`kind IN ('sweep', 'recover', 'fee_return', 'holdback_repay')`,
    ),
    check(
      'share_transfers_status',
      sql`status IN ('waiting', 'out_sent', 'out_paid', 'in_sent', 'done', 'cancelled', 'gap', 'review')`,
    ),
    check('share_transfers_amount', sql`amount_minor > 0`),
    check(
      'share_transfers_deliver',
      sql`deliver_minor IS NULL OR (deliver_minor >= 0 AND deliver_minor <= amount_minor)`,
    ),
    // Without an `out` leg there is nothing to wait for or claim on the way out.
    check(
      'share_transfers_one_leg',
      sql`kind IN ('sweep', 'recover') OR status NOT IN ('waiting', 'out_sent', 'gap')`,
    ),
    check(
      'share_transfers_links',
      sql`(kind = 'recover') = (reversal_transaction_id IS NOT NULL)
        AND (kind = 'fee_return') = (partner_reversal_id IS NOT NULL)
        AND (kind = 'holdback_repay') = (parent_id IS NOT NULL AND holdback_id IS NOT NULL)`,
    ),
    check(
      'share_transfers_business',
      sql`kind = 'fee_return' OR business_id IS NOT NULL`,
    ),
    uniqueIndex('share_transfers_one_sweep')
      .on(table.tipId)
      .where(sql`kind = 'sweep'`),
    uniqueIndex('share_transfers_once_per_reversal')
      .on(table.reversalTransactionId)
      .where(sql`kind = 'recover'`),
    // A fee goes back once per partner refund or dispute, however often its events arrive.
    uniqueIndex('share_transfers_fee_once')
      .on(table.partnerReversalId)
      .where(sql`kind = 'fee_return'`),
    uniqueIndex('share_transfers_once_per_holdback')
      .on(table.parentId, table.holdbackId)
      .where(sql`parent_id IS NOT NULL`),
    index('share_transfers_due').on(table.status, table.nextAttemptAt),
    index('share_transfers_business').on(table.businessId, table.status),
  ],
);

/**
 * A refunded tip's share the business had already withdrawn (owner, 11 Nov 2026): TipMe could not
 * pull it back, so it is held back from the business's later shares and paid to the staff member
 * until `remaining_minor` is zero. The business is told in the app.
 */
export const shareHoldbacks = pgTable(
  'share_holdbacks',
  {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    tipId: uuid('tip_id')
      .notNull()
      .references(() => tips.id),
    // The recovery that found the money gone: one hold-back each.
    recoverId: uuid('recover_id')
      .notNull()
      .unique()
      .references(() => shareTransfers.id),
    currency: currency(),
    amountMinor: minor('amount_minor').notNull(),
    remainingMinor: minor('remaining_minor').notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    currencyCheck('share_holdbacks'),
    check(
      'share_holdbacks_amounts',
      sql`amount_minor > 0 AND remaining_minor >= 0 AND remaining_minor <= amount_minor`,
    ),
    check(
      'share_holdbacks_settled',
      sql`(remaining_minor = 0) = (settled_at IS NOT NULL)`,
    ),
    index('share_holdbacks_open')
      .on(table.businessId, table.createdAt)
      .where(sql`remaining_minor > 0`),
  ],
);
