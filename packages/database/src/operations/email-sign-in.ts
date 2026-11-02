import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  and,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  emailCodeLockouts,
  emailCodes,
  emailTokens,
  profiles,
  sessions,
  staff,
  users,
} from '../schema.js';
import { recordAudit } from './audit.js';
import {
  emailChangedAtFor,
  maskEmail,
  normaliseEmail,
  normaliseStaffEmail,
} from './email-address.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';
import { enqueueMail, type MailSealing } from './mail-queue.js';
import {
  dropOpsAccess,
  isActiveStaff,
  lockedActiveStaff,
  lockStaffAdmin,
  looksLikeAuditChange,
  voidEnrolments,
  withAuditChange,
} from './staff.js';

export const EMAIL_CODE_TTL_MS = 10 * 60_000;
export const EMAIL_CODES_PER_HOUR = 3;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

export type EmailCodePurpose =
  | 'sign_in'
  | 'email_change'
  | 'recovery_email'
  | 'recovery'
  | 'recovery_new_email'
  | 'payout_destination';

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
        // Per purpose: someone's email change can't use up the owner's sign-in codes.
        eq(emailCodes.purpose, input.purpose),
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

export type EmailCodeCheck = 'ok' | 'invalid' | 'expired' | 'locked';

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
    /** Leave a right code unspent: for checking it alongside another code. */
    keep?: boolean;
  },
): Promise<EmailCodeCheck> {
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
  // With no code waiting there is nothing to guess: counting it would let anyone lock an address.
  if (!latest || latest.consumedAt !== null) return 'invalid';
  const matches = sameHex(
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
  if (!input.keep)
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

export const verifiedOwner = (email: string) =>
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
): Promise<{ status: 'sent' | 'rate_limited' | 'locked' | 'staff_account' }> {
  const email = normaliseEmail(input.email);
  if (!email) return Promise.resolve({ status: 'sent' });
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => ({
      status: (await isActiveStaff(tx, input.userId))
        ? ('staff_account' as const)
        : await issueEmailCode(tx, sealing, {
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
  | { status: 'invalid' | 'expired' | 'locked' | 'taken' | 'staff_account' };

/**
 * Moves the account to a proven new address: the old address is told and every other session ends.
 * Refused for active staff: an owner's reset is emailed here, so moving it is a server-side decision.
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
      if (await lockedActiveStaff(tx, input.userId))
        return { status: 'staff_account' };
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
        .select({
          email: users.email,
          verifiedAt: users.emailVerifiedAt,
          recoveryEmail: users.recoveryEmail,
        })
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
        .set({
          email,
          emailVerifiedAt: now,
          emailChangedAt: emailChangedAtFor(email, now),
          // The sign-in address can't also be its own way back in.
          ...(me?.recoveryEmail?.toLowerCase() === email
            ? { recoveryEmail: null, recoveryEmailVerifiedAt: null }
            : {}),
        })
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
      // A confirmation link from before this change can't move the account back.
      await tx
        .update(emailTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(emailTokens.userId, input.userId),
            eq(emailTokens.purpose, 'verify'),
            isNull(emailTokens.usedAt),
          ),
        );
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
      // Not staff (checked above), but a removed person's leftovers must not survive the move.
      await dropOpsAccess(tx, input.userId, now);
      const [page] = await tx
        .select({ handle: profiles.handleLower })
        .from(profiles)
        .where(eq(profiles.userId, input.userId));
      return { status: 'ok', email, handle: page?.handle ?? null };
    }),
  );
}

/**
 * For `pnpm ops:set-email`: gives an existing account a proven address, on someone's say-so. Named
 * by page handle, or by its current address for accounts with no page, such as staff. The old
 * address is told when a mail key is at hand; the log says whether it was.
 */
export function setAccountEmail(
  db: Database,
  input: ({ handle: string } | { currentEmail: string }) & {
    email: string;
    reason: string;
    sealing?: MailSealing;
    now?: Date;
  },
): Promise<
  | 'set'
  | 'taken'
  | 'not_found'
  | 'invalid'
  | 'bad_reason'
  | 'needs_mail_key'
  | 'staff_mailbox_taken'
> {
  const email = normaliseEmail(input.email);
  if (!email) return Promise.resolve('invalid');
  if (looksLikeAuditChange(input.reason)) return Promise.resolve('bad_reason');
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      // Who is staff must hold still, and it keeps this in the order deleting an account uses.
      await lockStaffAdmin(tx);
      const current =
        'currentEmail' in input ? normaliseEmail(input.currentEmail) : null;
      const [page] =
        'handle' in input
          ? await tx
              .select({ userId: profiles.userId })
              .from(profiles)
              .where(eq(profiles.handleLower, input.handle.toLowerCase()))
          : current
            ? await tx
                .select({ userId: users.id })
                .from(users)
                .where(verifiedOwner(current))
            : [];
      if (!page?.userId) return 'not_found';
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(verifiedOwner(email));
      if (owner && owner.id !== page.userId) return 'taken';
      // The one route that may move a staff account: whoever runs it vouches, and it's logged.
      const isStaff = await lockedActiveStaff(tx, page.userId);
      // Someone's staff address must not move unseen: without a key the old one can't be told.
      if (isStaff && !input.sealing) return 'needs_mail_key';
      const mailbox = normaliseStaffEmail(email);
      const others = await tx
        .select({ email: users.email })
        .from(staff)
        .innerJoin(users, eq(users.id, staff.userId))
        .where(and(isNull(staff.revokedAt), ne(staff.userId, page.userId)));
      if (
        others.some(
          (other) =>
            other.email && normaliseStaffEmail(other.email) === mailbox,
        )
      )
        return 'staff_mailbox_taken';
      const [before] = await tx
        .select({ email: users.email, verifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.id, page.userId));
      await tx
        .update(users)
        .set({
          email,
          emailVerifiedAt: now,
          emailChangedAt: emailChangedAtFor(email, now),
        })
        .where(eq(users.id, page.userId));
      if (isStaff) await voidEnrolments(tx, page.userId, now);
      const tell =
        input.sealing && before?.email && before.verifiedAt
          ? before.email !== email
          : false;
      if (tell)
        await enqueueMail(tx, input.sealing!, {
          type: 'email_changed_notice',
          to: before!.email!,
          userId: page.userId,
          data: { newEmailHint: maskEmail(email) },
          dedupeKey: `email_changed_notice.${page.userId}.${newId()}`,
          now,
        });
      await recordAudit(tx, {
        staffUserId: null,
        action: 'account.email_set_by_script',
        subjectType: 'user',
        subjectId: page.userId,
        reason: withAuditChange(input.reason, {
          from: before?.email ? maskEmail(before.email) : null,
          to: maskEmail(email),
          staff: isStaff,
          oldAddressNotified: tell,
        }),
        now,
      });
      return 'set';
    }),
  );
}

/**
 * These hold addresses anyone can type, so they don't stay: codes go a day after expiring, and a
 * failure count goes once no code remains and no lock is running. Returns lockout rows removed.
 */
export async function purgeEmailCodes(
  db: Database,
  now: Date,
): Promise<number> {
  await db
    .delete(emailCodes)
    .where(lt(emailCodes.expiresAt, new Date(now.getTime() - 86_400_000)));
  const removed = await db
    .delete(emailCodeLockouts)
    .where(
      and(
        or(
          isNull(emailCodeLockouts.lockedUntil),
          lt(emailCodeLockouts.lockedUntil, now),
        ),
        sql`NOT EXISTS (SELECT 1 FROM ${emailCodes} c WHERE c.email = ${emailCodeLockouts.email})`,
      ),
    )
    .returning({ email: emailCodeLockouts.email });
  return removed.length;
}
