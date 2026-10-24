import {
  ISSUE_KINDS,
  type OpsIssueKind as IssueKind,
  type OpsIssueSeverity as IssueSeverity,
  type OpsIssueSubject as IssueSubject,
} from '@tipme/contracts';
import { ATTEMPT_STATUSES, PAYOUT_STATUSES, TIP_STATUSES } from '@tipme/domain';
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
export const payoutStatus = pgEnum('payout_status', PAYOUT_STATUSES);
export const profileVisibility = pgEnum('profile_visibility', [
  'public',
  'hidden',
]);
export const profileStatus = pgEnum('profile_status', ['active', 'suspended']);
export const entityType = pgEnum('entity_type', ['tip', 'attempt', 'payout']);
export const transitionCause = pgEnum('transition_cause', [
  'provider_event',
  'system',
  'expiry',
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
]);

/** Auth subject and contact details arrive with ADR-0003. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  status: text('status').notNull().default('active'),
  // E.164 phone number: the identity. Nulled when the account is deleted (PR-008).
  phoneE164: text('phone_e164').unique(),
  email: text('email'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: createdAt(),
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
    socials: jsonb('socials')
      .$type<{ facebook?: string; instagram?: string; x?: string }>()
      .notNull()
      .default({}),
    bioPublic: boolean('bio_public').notNull().default(true),
    socialsPublic: boolean('socials_public').notNull().default(true),
    phonePublic: boolean('phone_public').notNull().default(false),
    emailPublic: boolean('email_public').notNull().default(false),
    qrStyle: text('qr_style').notNull().default('purple'),
    // The page's photo version (PR-013): only ever goes up, so a photo URL is never reused, not
    // even after removing a photo and adding another.
    avatarVersion: integer('avatar_version').notNull().default(0),
    // When the page first went live (PR-013): `profile_published` is recorded once, ever.
    firstPublishedAt: timestamp('first_published_at', { withTimezone: true }),
    // Notification preferences (PR-013): what the recipient chose not to be told about.
    notifyTipEmails: boolean('notify_tip_emails').notNull().default(true),
    notifyWeeklyReports: boolean('notify_weekly_reports')
      .notNull()
      .default(true),
    notifyMilestones: boolean('notify_milestones').notNull().default(true),
    // Free or Pro (PR-012). Staff set it; there is no billing while money is pretend.
    plan: text('plan').notNull().default('free'),
    // A Pro page's own tip amounts (kobo), kept when the page goes back to Free.
    tipPresetsMinor: bigint('tip_presets_minor', { mode: 'bigint' }).array(),
    minTipMinor: minor('min_tip_minor'),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'profiles_page_state',
      sql`page_state IN ('live', 'not_live', 'deleted')`,
    ),
    check('profiles_plan', sql`plan IN ('free', 'pro')`),
    // Admin search by handle prefix (PR-013); the unique index cannot serve LIKE 'x%'.
    index('profiles_handle_prefix').on(
      table.handleLower.op('text_pattern_ops'),
    ),
    // Amounts in whole naira, never below the ₦1,000 floor (no maximum); 1 to 4 presets.
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
    title: text('title').notNull(),
    body: text('body').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'notifications_kind',
      sql`kind IN ('tip', 'weekly_report', 'moment')`,
    ),
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
 * work, and nobody else can claim them. At most 5 per page; released as 90-day holds on deletion.
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

export const tipQuotes = pgTable(
  'tip_quotes',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
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
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  () => [
    currencyCheck('tip_quotes'),
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
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
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
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    currency: currency(),
    grossMinor: minor('gross_minor').notNull(),
    status: tipStatus('status').notNull(),
    payerDisplayLabel: text('payer_display_label'),
    // Started from a recipient's shared celebration ("add to the celebration").
    celebrationMomentId: uuid('celebration_moment_id'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    currencyCheck('tips'),
    check('tips_gross_positive', sql`gross_minor > 0`),
    check(
      'tips_label_length',
      sql`payer_display_label IS NULL OR char_length(payer_display_label) <= 60`,
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
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
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
    createdAt: createdAt(),
  },
  (table) => [
    currencyCheck('payouts'),
    check('payouts_amount_positive', sql`amount_minor > 0`),
    unique('payouts_provider_reference').on(
      table.provider,
      table.providerReference,
    ),
    // Admin search (PR-013).
    index('payouts_reference').on(table.providerReference),
    index('payouts_reference_end').on(
      sql`lower(right(${table.providerReference}, 6))`,
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
  },
  (table) => [
    currencyCheck('ledger_accounts'),
    // NULLS NOT DISTINCT: global accounts (no profile) are unique per code and currency too.
    unique('ledger_accounts_identity')
      .on(table.code, table.currency, table.profileId)
      .nullsNotDistinct(),
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

// ---- Staff access and audit (PR-009, ADR-0010) ----

export const OPS_PERMISSIONS = [
  'issues.view',
  'issues.resolve',
  'pages.suspend',
  'recoveries.cancel',
  'analytics.view',
  'market.edit',
  'audit.view',
  'payments.recheck',
  'private.view',
  'pages.plan',
  'search.view',
] as const;
export type OpsPermission = (typeof OPS_PERMISSIONS)[number];

/** A role is a named set of permissions, so new roles need no code change. Only `owner` is seeded. */
export const roles = pgTable('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

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
});

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
  },
  (table) => [index('ops_sessions_user').on(table.userId)],
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

export { ISSUE_KINDS };
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
  },
  (table) => [
    check(
      'issues_kind',
      sql`kind IN (${sql.raw(ISSUE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    ),
    check('issues_severity', sql`severity IN ('money', 'account', 'info')`),
    check('issues_status', sql`status IN ('open', 'resolved')`),
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
  ],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * A page's photo (PR-013): one per page, already re-encoded on the server (512×512 WebP, no
 * metadata). In Postgres so it is backed up and recovered with everything else; about 30 KB.
 * `version` changes with each upload, so the URL can be cached for ever.
 */
export const profileAvatars = pgTable('profile_avatars', {
  profileId: uuid('profile_id')
    .primaryKey()
    .references(() => profiles.id),
  version: integer('version').notNull(),
  bytes: bytea('bytes').notNull(),
  createdAt: createdAt(),
});

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
