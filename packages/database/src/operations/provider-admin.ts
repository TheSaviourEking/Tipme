import { createHash, randomBytes } from 'node:crypto';
import type { MailProviderName } from '@tipme/mail';
import { and, desc, eq, gt, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  mailMessageEvents,
  mailMessages,
  mailSuppressions,
  profiles,
  providerOverrides,
  providerSettings,
  providerTests,
  users,
} from '../schema.js';
import { recordAudit } from './audit.js';
import { maskEmail, normaliseEmail } from './email-address.js';
import { OperationError } from './errors.js';
import { newId } from './ids.js';
import { addressHmac, enqueueMail, type MailSealing } from './mail-queue.js';

/** A confirmed test stands for this long; the link in the test email works for as long. */
export const PROVIDER_TEST_VALID_MS = 24 * 3_600_000;

export const MAIL_PROVIDER_LABELS: Record<MailProviderName, string> = {
  mock: 'Pretend provider',
  zeptomail: 'ZeptoMail',
  ses: 'Amazon SES',
};

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** The provider staff chose, or the server default until they choose one. */
export async function activeMailProvider(
  db: Database,
  fallback: MailProviderName,
): Promise<MailProviderName> {
  const [row] = await db
    .select({ provider: providerSettings.activeProvider })
    .from(providerSettings)
    .where(eq(providerSettings.kind, 'mail'));
  return (row?.provider as MailProviderName | undefined) ?? fallback;
}

export async function mailOverrideFor(
  db: Database,
  userId: string,
): Promise<MailProviderName | null> {
  const [row] = await db
    .select({ provider: providerOverrides.provider })
    .from(providerOverrides)
    .where(
      and(
        eq(providerOverrides.kind, 'mail'),
        eq(providerOverrides.userId, userId),
      ),
    );
  return (row?.provider as MailProviderName | undefined) ?? null;
}

/**
 * Queues a test email pinned to `provider`, so it goes through the real worker path. Opening its
 * link while signed in to ops proves it reached an inbox, which "accepted" would not.
 */
export function startMailProviderTest(
  db: Database,
  sealing: MailSealing,
  input: {
    staffUserId: string;
    provider: MailProviderName;
    to: string;
    webOrigin: string;
    now?: Date;
  },
): Promise<{ testId: string }> {
  const to = normaliseEmail(input.to);
  if (!to) return Promise.reject(new OperationError('INVALID_INPUT'));
  const now = input.now ?? new Date();
  const token = randomBytes(32).toString('base64url');
  const testId = newId();
  return db.transaction(async (tx) => {
    const { id: messageId } = await enqueueMail(tx, sealing, {
      type: 'provider_test',
      to,
      data: { providerLabel: MAIL_PROVIDER_LABELS[input.provider], token },
      dedupeKey: `provider_test.${testId}`,
      pinnedProvider: input.provider,
      now,
    });
    await tx.insert(providerTests).values({
      id: testId,
      kind: 'mail',
      provider: input.provider,
      startedBy: input.staffUserId,
      startedAt: now,
      targetHint: maskEmail(to),
      tokenSha256: sha256(token),
      messageId,
    });
    await recordAudit(tx, {
      staffUserId: input.staffUserId,
      action: 'mail_provider.test_started',
      permission: 'providers.manage',
      subjectType: 'mail_provider',
      subjectId: input.provider,
      now,
    });
    return { testId };
  });
}

/** One use, within 24 hours of the test starting. */
export function confirmProviderTest(
  db: Database,
  input: { token: string; staffUserId: string; now?: Date },
): Promise<'confirmed' | 'invalid'> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [test] = await tx
      .update(providerTests)
      .set({ status: 'confirmed', confirmedAt: now })
      .where(
        and(
          eq(providerTests.tokenSha256, sha256(input.token)),
          isNull(providerTests.confirmedAt),
          gt(
            providerTests.startedAt,
            new Date(now.getTime() - PROVIDER_TEST_VALID_MS),
          ),
        ),
      )
      .returning({ provider: providerTests.provider });
    if (!test) return 'invalid';
    await recordAudit(tx, {
      staffUserId: input.staffUserId,
      action: 'mail_provider.test_confirmed',
      subjectType: 'mail_provider',
      subjectId: test.provider,
      now,
    });
    return 'confirmed';
  });
}

export type MailSwitchOutcome =
  'switched' | 'no_confirmed_test' | 'not_configured' | 'refused_in_production';

export function switchMailProvider(
  db: Database,
  input: {
    staffUserId: string;
    provider: MailProviderName;
    reason: string;
    production: boolean;
    /** The provider's own status: true while it only delivers to verified recipients. */
    sandbox: boolean | null;
    configured: ReadonlySet<MailProviderName>;
    now?: Date;
  },
): Promise<MailSwitchOutcome> {
  const now = input.now ?? new Date();
  if (!input.configured.has(input.provider))
    return Promise.resolve('not_configured');
  if (input.production && (input.provider === 'mock' || input.sandbox === true))
    return Promise.resolve('refused_in_production');
  return db.transaction(async (tx) => {
    const [test] = await tx
      .select({ id: providerTests.id })
      .from(providerTests)
      .where(
        and(
          eq(providerTests.kind, 'mail'),
          eq(providerTests.provider, input.provider),
          eq(providerTests.status, 'confirmed'),
          gte(
            providerTests.confirmedAt,
            new Date(now.getTime() - PROVIDER_TEST_VALID_MS),
          ),
        ),
      )
      .orderBy(desc(providerTests.confirmedAt))
      .limit(1);
    if (!test) return 'no_confirmed_test';
    const values = {
      activeProvider: input.provider,
      changedBy: input.staffUserId,
      changedAt: now,
      reason: input.reason,
    };
    await tx
      .insert(providerSettings)
      .values({ kind: 'mail', ...values })
      .onConflictDoUpdate({ target: providerSettings.kind, set: values });
    await recordAudit(tx, {
      staffUserId: input.staffUserId,
      action: 'mail_provider.switched',
      permission: 'providers.manage',
      subjectType: 'mail_provider',
      subjectId: input.provider,
      reason: input.reason,
      now,
    });
    return 'switched';
  });
}

export function setProviderOverride(
  db: Database,
  input: {
    kind: 'mail' | 'payment';
    userId: string;
    provider: string;
    staffUserId: string;
    reason: string;
  },
): Promise<void> {
  return db.transaction(async (tx) => {
    const values = {
      provider: input.provider,
      setBy: input.staffUserId,
      reason: input.reason,
    };
    await tx
      .insert(providerOverrides)
      .values({ kind: input.kind, userId: input.userId, ...values })
      .onConflictDoUpdate({
        target: [providerOverrides.kind, providerOverrides.userId],
        set: values,
      });
    await recordAudit(tx, {
      staffUserId: input.staffUserId,
      action: `${input.kind}_provider.override_set`,
      permission: 'providers.manage',
      subjectType: 'user',
      subjectId: input.userId,
      reason: input.reason,
    });
  });
}

export function removeProviderOverride(
  db: Database,
  input: {
    kind: 'mail' | 'payment';
    userId: string;
    staffUserId: string;
    reason: string;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(providerOverrides)
      .where(
        and(
          eq(providerOverrides.kind, input.kind),
          eq(providerOverrides.userId, input.userId),
        ),
      )
      .returning({ userId: providerOverrides.userId });
    if (removed.length === 0) return false;
    await recordAudit(tx, {
      staffUserId: input.staffUserId,
      action: `${input.kind}_provider.override_removed`,
      permission: 'providers.manage',
      subjectType: 'user',
      subjectId: input.userId,
      reason: input.reason,
    });
    return true;
  });
}

export async function findSuppression(
  db: Database,
  sealing: MailSealing,
  address: string,
): Promise<{
  reason: string;
  provider: string | null;
  createdAt: string;
} | null> {
  const [row] = await db
    .select()
    .from(mailSuppressions)
    .where(eq(mailSuppressions.addressHmac, addressHmac(sealing, address)));
  return row
    ? {
        reason: row.reason,
        provider: row.provider,
        createdAt: row.createdAt.toISOString(),
      }
    : null;
}

/** Someone who complained asked not to be emailed, so removing that takes explicit confirmation. */
export function removeSuppression(
  db: Database,
  sealing: MailSealing,
  input: {
    address: string;
    staffUserId: string;
    reason: string;
    confirmComplaint: boolean;
  },
): Promise<'removed' | 'not_found' | 'complaint_needs_confirmation'> {
  const hmac = addressHmac(sealing, input.address);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ reason: mailSuppressions.reason })
      .from(mailSuppressions)
      .where(eq(mailSuppressions.addressHmac, hmac))
      .for('update');
    if (!row) return 'not_found';
    if (row.reason === 'complaint' && !input.confirmComplaint)
      return 'complaint_needs_confirmation';
    await tx
      .delete(mailSuppressions)
      .where(eq(mailSuppressions.addressHmac, hmac));
    await recordAudit(tx, {
      staffUserId: input.staffUserId,
      action: 'mail.suppression_removed',
      permission: 'providers.manage',
      subjectType: 'mail_suppression',
      subjectId: hmac.slice(0, 16),
      reason: input.reason,
    });
    return 'removed';
  });
}

export interface MailProviderOverview {
  active: MailProviderName;
  changedAt: string | null;
  reason: string | null;
  providers: Array<{
    name: MailProviderName;
    label: string;
    active: boolean;
    canActivate: boolean;
    lastTest: {
      status: 'pending' | 'confirmed' | 'failed' | 'expired';
      startedAt: string;
      confirmedAt: string | null;
      targetHint: string | null;
      messageStatus: string | null;
      failureCode: string | null;
    } | null;
    last24h: {
      sent: number;
      failed: number;
      bounced: number;
      complained: number;
    };
  }>;
  overrides: Array<{
    userId: string;
    handle: string | null;
    provider: string;
    reason: string;
    createdAt: string;
  }>;
}

/** What the Providers page shows, for the configured providers. Never a key or an address. */
export async function mailProviderOverview(
  db: Database,
  input: {
    configured: readonly MailProviderName[];
    fallback: MailProviderName;
    now?: Date;
  },
): Promise<MailProviderOverview> {
  const now = input.now ?? new Date();
  const [settings] = await db
    .select()
    .from(providerSettings)
    .where(eq(providerSettings.kind, 'mail'));
  const active =
    (settings?.activeProvider as MailProviderName | undefined) ??
    input.fallback;
  const counts = await db
    .select({
      provider: mailMessageEvents.provider,
      kind: mailMessageEvents.kind,
      n: sql<number>`count(*)::int`,
    })
    .from(mailMessageEvents)
    .where(
      and(
        gte(
          mailMessageEvents.occurredAt,
          new Date(now.getTime() - 24 * 3_600_000),
        ),
        isNotNull(mailMessageEvents.provider),
      ),
    )
    .groupBy(mailMessageEvents.provider, mailMessageEvents.kind);
  const count = (provider: string, kind: string) =>
    counts.find((c) => c.provider === provider && c.kind === kind)?.n ?? 0;
  const providers = await Promise.all(
    input.configured.map(async (name) => {
      const [test] = await db
        .select({
          test: providerTests,
          messageStatus: mailMessages.status,
          lastError: mailMessages.lastError,
        })
        .from(providerTests)
        .leftJoin(mailMessages, eq(mailMessages.id, providerTests.messageId))
        .where(
          and(eq(providerTests.kind, 'mail'), eq(providerTests.provider, name)),
        )
        .orderBy(desc(providerTests.startedAt))
        .limit(1);
      const [valid] = await db
        .select({ id: providerTests.id })
        .from(providerTests)
        .where(
          and(
            eq(providerTests.kind, 'mail'),
            eq(providerTests.provider, name),
            eq(providerTests.status, 'confirmed'),
            gte(
              providerTests.confirmedAt,
              new Date(now.getTime() - PROVIDER_TEST_VALID_MS),
            ),
          ),
        )
        .limit(1);
      return {
        name,
        label: MAIL_PROVIDER_LABELS[name],
        active: name === active,
        canActivate: Boolean(valid),
        lastTest: test
          ? {
              status: test.test.status as
                'pending' | 'confirmed' | 'failed' | 'expired',
              startedAt: test.test.startedAt.toISOString(),
              confirmedAt: test.test.confirmedAt?.toISOString() ?? null,
              targetHint: test.test.targetHint,
              messageStatus: test.messageStatus,
              failureCode: test.test.failureCode ?? test.lastError,
            }
          : null,
        last24h: {
          sent: count(name, 'sent'),
          failed: count(name, 'send_failed'),
          bounced: count(name, 'hard_bounce'),
          complained: count(name, 'complaint'),
        },
      };
    }),
  );
  const overrides = await db
    .select({
      userId: providerOverrides.userId,
      handle: profiles.handle,
      provider: providerOverrides.provider,
      reason: providerOverrides.reason,
      createdAt: providerOverrides.createdAt,
    })
    .from(providerOverrides)
    .leftJoin(profiles, eq(profiles.userId, providerOverrides.userId))
    .where(eq(providerOverrides.kind, 'mail'))
    .orderBy(desc(providerOverrides.createdAt));
  return {
    active,
    changedAt: settings?.changedAt.toISOString() ?? null,
    reason: settings?.reason ?? null,
    providers,
    overrides: overrides.map((o) => ({
      ...o,
      createdAt: o.createdAt.toISOString(),
    })),
  };
}

/** The account behind a handle or user id, for staff forms. */
export async function findAccountByHandleOrId(
  db: Database,
  account: string,
): Promise<string | null> {
  const value = account.trim().replace(/^@/, '').toLowerCase();
  const [row] = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.handleLower, value));
  if (row?.userId) return row.userId;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    return null;
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, value), isNull(users.deletedAt)));
  return user?.id ?? null;
}

/** The staff member's own confirmed address: where a test goes by default. */
export async function verifiedEmailOf(
  db: Database,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), isNotNull(users.emailVerifiedAt)));
  return row?.email ?? null;
}
