import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  and,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  emailCodeLockouts,
  emailCodes,
  emailTokens,
  profiles,
  sessions,
  users,
} from '../schema.js';
import { maskEmail, normaliseEmail } from './email-address.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';
import { enqueueMail, type MailSealing } from './mail-queue.js';
import { dropOpsAccess } from './staff.js';

export const EMAIL_CODE_TTL_MS = 10 * 60_000;
export const EMAIL_CODES_PER_HOUR = 3;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

export type EmailCodePurpose =
  | 'sign_in'
  | 'email_change'
  | 'recovery_email'
  | 'recovery'
  | 'recovery_new_email';

const hmacOf = (secret: string, email: string, purpose: string, code: string) =>
  createHmac('sha256', secret)
    .update(`email:${email}:${purpose}:${code}`)
    .digest('hex');

const sameHex = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function isLocked(tx: Database | Tx, email: string, now: Date) {
  const [row] = await tx
    .select({ until: emailCodeLockouts.lockedUntil })
    .from(emailCodeLockouts)
    .where(eq(emailCodeLockouts.email, email));
  return Boolean(row?.until && row.until > now);
}

/** Issues a code and queues its email in one transaction, within the per-address limits. */
export async function issueEmailCode(
  tx: Tx,
  sealing: MailSealing,
  input: {
    email: string;
    purpose: EmailCodePurpose;
    mailType: string;
    secret: string;
    userId?: string | null;
    now: Date;
    codesPerHour?: number;
  },
): Promise<'sent' | 'rate_limited' | 'locked'> {
  if (await isLocked(tx, input.email, input.now)) return 'locked';
  const [recent] = await tx
    .select({ n: count() })
    .from(emailCodes)
    .where(
      and(
        eq(emailCodes.email, input.email),
        gte(emailCodes.createdAt, new Date(input.now.getTime() - 3_600_000)),
      ),
    );
  if ((recent?.n ?? 0) >= (input.codesPerHour ?? EMAIL_CODES_PER_HOUR))
    return 'rate_limited';
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = newId();
  const expiresAt = new Date(input.now.getTime() + EMAIL_CODE_TTL_MS);
  await tx.insert(emailCodes).values({
    id,
    email: input.email,
    codeHmac: hmacOf(input.secret, input.email, input.purpose, code),
    purpose: input.purpose,
    expiresAt,
    createdAt: input.now,
  });
  await enqueueMail(tx, sealing, {
    type: input.mailType,
    to: input.email,
    userId: input.userId ?? null,
    data: { code },
    dedupeKey: `${input.mailType}.${id}`,
    // A code that can't arrive in time is never sent late.
    expiresAt,
    now: input.now,
  });
  return 'sent';
}

/**
 * Checks a code against the latest one for the address and purpose. Wrong codes count towards a
 * 15-minute lockout after five. Must run in the caller's transaction, with whatever it unlocks.
 */
export async function checkEmailCode(
  tx: Tx,
  input: {
    email: string;
    purpose: EmailCodePurpose;
    code: string;
    secret: string;
    now: Date;
  },
): Promise<'ok' | 'invalid' | 'expired' | 'locked'> {
  if (!/^\d{6}$/.test(input.code)) return 'invalid';
  if (await isLocked(tx, input.email, input.now)) return 'locked';
  const [latest] = await tx
    .select()
    .from(emailCodes)
    .where(
      and(
        eq(emailCodes.email, input.email),
        eq(emailCodes.purpose, input.purpose),
      ),
    )
    .orderBy(desc(emailCodes.createdAt))
    .limit(1)
    .for('update');
  const matches =
    latest !== undefined &&
    latest.consumedAt === null &&
    sameHex(
      latest.codeHmac,
      hmacOf(input.secret, input.email, input.purpose, input.code),
    );
  if (!matches) {
    const [row] = await tx
      .insert(emailCodeLockouts)
      .values({ email: input.email, failures: 1 })
      .onConflictDoUpdate({
        target: emailCodeLockouts.email,
        set: { failures: sql`${emailCodeLockouts.failures} + 1` },
      })
      .returning({ failures: emailCodeLockouts.failures });
    if ((row?.failures ?? 0) < MAX_FAILURES) return 'invalid';
    await tx
      .update(emailCodeLockouts)
      .set({
        failures: 0,
        lockedUntil: new Date(input.now.getTime() + LOCKOUT_MS),
      })
      .where(eq(emailCodeLockouts.email, input.email));
    return 'locked';
  }
  if (latest.expiresAt <= input.now) return 'expired';
  await tx
    .update(emailCodes)
    .set({ consumedAt: input.now })
    .where(eq(emailCodes.id, latest.id));
  await tx
    .insert(emailCodeLockouts)
    .values({ email: input.email, failures: 0 })
    .onConflictDoUpdate({
      target: emailCodeLockouts.email,
      set: { failures: 0, lockedUntil: null },
    });
  return 'ok';
}

/**
 * Emails a 6-digit sign-in code. The caller answers the same whatever happens here, so the
 * response never reveals which addresses have accounts. A malformed address stores nothing.
 */
export function requestEmailSignInCode(
  db: Database,
  sealing: MailSealing,
  input: {
    email: string;
    secret: string;
    now?: Date;
    codesPerHour?: number;
  },
): Promise<{ status: 'sent' | 'rate_limited' | 'locked' }> {
  const email = normaliseEmail(input.email);
  if (!email) return Promise.resolve({ status: 'sent' });
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(verifiedOwner(email));
      return {
        status: await issueEmailCode(tx, sealing, {
          email,
          purpose: 'sign_in',
          mailType: 'sign_in_code',
          secret: input.secret,
          userId: owner?.id ?? null,
          now,
          ...(input.codesPerHour ? { codesPerHour: input.codesPerHour } : {}),
        }),
      };
    }),
  );
}

const verifiedOwner = (email: string) =>
  and(
    sql`lower(${users.email}) = ${email}`,
    isNotNull(users.emailVerifiedAt),
    isNull(users.deletedAt),
  );

export type EmailVerifyResult =
  | { status: 'ok'; userId: string; created: boolean }
  | { status: 'invalid' | 'expired' | 'locked' };

/**
 * A correct code signs in to the account where this address is proven, creating it the first
 * time. Only a proven address can sign in: anyone else's unproven claim of it is cleared here, so
 * typing a victim's address onto your own account can never later sign them into it.
 */
export function verifyEmailSignInCode(
  db: Database,
  sealing: MailSealing,
  input: {
    email: string;
    code: string;
    secret: string;
    deviceHash: string | null;
    deviceLabel?: string;
    webOrigin: string;
    now?: Date;
  },
): Promise<EmailVerifyResult> {
  const email = normaliseEmail(input.email);
  if (!email) return Promise.resolve({ status: 'invalid' });
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx): Promise<EmailVerifyResult> => {
      const checked = await checkEmailCode(tx, {
        email,
        purpose: 'sign_in',
        code: input.code,
        secret: input.secret,
        now,
      });
      if (checked !== 'ok') return { status: checked };
      await tx
        .update(users)
        .set({ email: null })
        .where(
          and(
            sql`lower(${users.email}) = ${email}`,
            isNull(users.emailVerifiedAt),
          ),
        );
      await tx
        .delete(emailTokens)
        .where(
          and(
            sql`lower(${emailTokens.email}) = ${email}`,
            eq(emailTokens.purpose, 'verify'),
            isNull(emailTokens.usedAt),
          ),
        );
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(verifiedOwner(email));
      if (owner) {
        if (input.deviceHash) {
          const [seen] = await tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                eq(sessions.userId, owner.id),
                eq(sessions.deviceHash, input.deviceHash),
              ),
            )
            .limit(1);
          if (!seen)
            await enqueueMail(tx, sealing, {
              type: 'new_sign_in_notice',
              to: email,
              userId: owner.id,
              data: { deviceLabel: (input.deviceLabel ?? '').slice(0, 80) },
              dedupeKey: `new_sign_in_notice.${owner.id}.${newId()}`,
              now,
            });
        }
        return { status: 'ok', userId: owner.id, created: false };
      }
      const id = newId();
      await tx.insert(users).values({ id, email, emailVerifiedAt: now });
      await enqueueMail(tx, sealing, {
        type: 'welcome',
        to: email,
        userId: id,
        data: {},
        dedupeKey: `welcome.${id}`,
        now,
      });
      return { status: 'ok', userId: id, created: true };
    }),
  );
}

/** A code to the new address. The caller answers the same whether or not it is in use. */
export function requestEmailChangeCode(
  db: Database,
  sealing: MailSealing,
  input: { userId: string; email: string; secret: string; now?: Date },
): Promise<{ status: 'sent' | 'rate_limited' | 'locked' }> {
  const email = normaliseEmail(input.email);
  if (!email) return Promise.resolve({ status: 'sent' });
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => ({
      status: await issueEmailCode(tx, sealing, {
        email,
        purpose: 'email_change',
        mailType: 'email_change_code',
        secret: input.secret,
        userId: input.userId,
        now,
      }),
    })),
  );
}

export type EmailChangeResult =
  | { status: 'ok'; email: string; handle: string | null }
  | { status: 'invalid' | 'expired' | 'locked' | 'taken' };

/**
 * Moves the account to a proven new address: the old address is told, every other session ends,
 * and staff access must be set up again, as when a phone number changes.
 */
export function changeEmail(
  db: Database,
  sealing: MailSealing,
  input: {
    userId: string;
    email: string;
    code: string;
    secret: string;
    keepSessionId: string;
    now?: Date;
  },
): Promise<EmailChangeResult> {
  const email = normaliseEmail(input.email);
  if (!email) return Promise.resolve({ status: 'invalid' });
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx): Promise<EmailChangeResult> => {
      const checked = await checkEmailCode(tx, {
        email,
        purpose: 'email_change',
        code: input.code,
        secret: input.secret,
        now,
      });
      if (checked !== 'ok') return { status: checked };
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(verifiedOwner(email));
      if (owner && owner.id !== input.userId) return { status: 'taken' };
      const [me] = await tx
        .select({ email: users.email, verifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.id, input.userId))
        .for('update');
      await tx
        .update(users)
        .set({ email: null })
        .where(
          and(
            sql`lower(${users.email}) = ${email}`,
            isNull(users.emailVerifiedAt),
            ne(users.id, input.userId),
          ),
        );
      await tx
        .update(users)
        .set({ email, emailVerifiedAt: now })
        .where(eq(users.id, input.userId));
      if (me?.email && me.verifiedAt && me.email !== email)
        await enqueueMail(tx, sealing, {
          type: 'email_changed_notice',
          to: me.email,
          userId: input.userId,
          data: { newEmailHint: maskEmail(email) },
          dedupeKey: `email_changed_notice.${input.userId}.${newId()}`,
          now,
        });
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(sessions.userId, input.userId),
            isNull(sessions.revokedAt),
            ne(sessions.id, input.keepSessionId),
          ),
        );
      await dropOpsAccess(tx, input.userId, now);
      const [page] = await tx
        .select({ handle: profiles.handleLower })
        .from(profiles)
        .where(eq(profiles.userId, input.userId));
      return { status: 'ok', email, handle: page?.handle ?? null };
    }),
  );
}
