import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, ne } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  emailTokens,
  phoneRecoveries,
  profiles,
  sessions,
  users,
} from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { normalisePhone, phoneHint } from './phone.js';
import { writePretendMessage } from './pretend-outbox.js';
import { dropOpsAccess, isActiveStaff } from './staff.js';
import { verifySignInCode } from './sign-in.js';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RECOVER_TTL_MS = 30 * 60 * 1000;
/** A recovery takes effect only after this, so the owner can still stop it. */
export const RECOVERY_HOLD_MS = 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** "t•••@example.com": enough to recognise, never the whole address. */
export const maskEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

export const normaliseEmail = (raw: string): string | null => {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
};

/** Sends a link (pretend mailbox) that proves the user owns the address. */
export function startEmailVerification(
  db: Database,
  input: { userId: string; email: string; webOrigin: string; now?: Date },
): Promise<void> {
  const email = normaliseEmail(input.email);
  if (!email) return Promise.reject(new OperationError('INVALID_INPUT'));
  const now = input.now ?? new Date();
  const token = randomBytes(32).toString('base64url');
  return guarded(() =>
    db.transaction(async (tx) => {
      await tx.insert(emailTokens).values({
        tokenSha256: sha256(token),
        userId: input.userId,
        email,
        purpose: 'verify',
        expiresAt: new Date(now.getTime() + VERIFY_TTL_MS),
      });
      await writePretendMessage(tx, {
        channel: 'email',
        recipientHint: maskEmail(email),
        userId: input.userId,
        subject: 'Confirm your email for TipMe',
        body: `Confirm this address for your TipMe account: ${new URL(input.webOrigin).origin}/verify-email#v=${token} (valid for 24 hours). If you didn’t ask for this, ignore this email.`,
      });
    }),
  );
}

async function useToken(
  db: Database,
  token: string,
  purpose: 'verify' | 'recover',
  now: Date,
  consume: boolean,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [found] = await db
    .select({ token: emailTokens })
    .from(emailTokens)
    .innerJoin(users, eq(users.id, emailTokens.userId))
    .where(
      and(
        eq(emailTokens.tokenSha256, sha256(token)),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, now),
        // A deleted account's links never work again.
        isNull(users.deletedAt),
      ),
    );
  const row = found?.token;
  if (!row) return null;
  if (consume)
    await db
      .update(emailTokens)
      .set({ usedAt: now })
      .where(eq(emailTokens.tokenSha256, row.tokenSha256));
  return row;
}

export function confirmEmail(
  db: Database,
  input: { token: string; now?: Date },
): Promise<'confirmed' | 'invalid'> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const row = await useToken(db, input.token, 'verify', now, true);
    if (!row) return 'invalid';
    await db
      .update(users)
      .set({ email: row.email, emailVerifiedAt: now })
      .where(eq(users.id, row.userId));
    return 'confirmed';
  });
}

/**
 * Recovery by email: a link to attach a new phone number. Only for a verified address; the answer
 * is the same either way, so it never reveals which addresses have accounts.
 */
export function startRecovery(
  db: Database,
  input: { email: string; webOrigin: string; now?: Date },
): Promise<'sent'> {
  const email = normaliseEmail(input.email);
  const now = input.now ?? new Date();
  return guarded(async (): Promise<'sent'> => {
    if (!email) return 'sent';
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.email, email),
          isNotNull(users.emailVerifiedAt),
          isNull(users.deletedAt),
        ),
      );
    // Staff accounts are never recovered by email (ADR-0010); the answer stays the same.
    if (!user || (await isActiveStaff(db, user.id))) return 'sent';
    const token = randomBytes(32).toString('base64url');
    await db.transaction(async (tx) => {
      await tx.insert(emailTokens).values({
        tokenSha256: sha256(token),
        userId: user.id,
        email,
        purpose: 'recover',
        expiresAt: new Date(now.getTime() + RECOVER_TTL_MS),
      });
      await writePretendMessage(tx, {
        channel: 'email',
        recipientHint: maskEmail(email),
        userId: user.id,
        subject: 'Get back into TipMe',
        body: `Lost your phone number? Attach a new one here: ${new URL(input.webOrigin).origin}/recover#r=${token} (valid for 30 minutes). You will need a code sent to the new number. If you didn’t ask for this, ignore this email.`,
      });
    });
    return 'sent';
  });
}

/** Whether a recovery link is still usable (without using it up). */
export function checkRecoveryToken(
  db: Database,
  token: string,
): Promise<boolean> {
  return guarded(
    async () =>
      (await useToken(db, token, 'recover', new Date(), false)) !== null,
  );
}

async function attachPhone(
  db: Database,
  input: { userId: string; newPhone: string; code: string; secret: string },
): Promise<string> {
  const phone = normalisePhone(input.newPhone);
  if (!phone) throw new OperationError('INVALID_INPUT');
  const verified = await verifySignInCode(db, {
    phone,
    code: input.code,
    secret: input.secret,
    purpose: 'change_phone',
  });
  if (verified.status !== 'ok') throw new OperationError('CODE_INVALID');
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phoneE164, phone), ne(users.id, input.userId)));
  if (owner) throw new OperationError('PHONE_TAKEN');
  await db
    .update(users)
    .set({ phoneE164: phone })
    .where(eq(users.id, input.userId));
  return phone;
}

/** A signed-in recipient moves to a new number, proven by a code sent to that number. */
export function changePhone(
  db: Database,
  input: {
    userId: string;
    newPhone: string;
    code: string;
    secret: string;
    keepSessionId?: string;
  },
): Promise<{ phone: string }> {
  return guarded(async () => {
    const phone = await attachPhone(db, input);
    await dropOpsAccess(db, input.userId);
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, input.userId),
          isNull(sessions.revokedAt),
          ...(input.keepSessionId
            ? [ne(sessions.id, input.keepSessionId)]
            : []),
        ),
      );
    return { phone };
  });
}

/** Recovery: link from the verified email + a code sent to the new number. Ends every session. */
export function completeRecovery(
  db: Database,
  input: {
    token: string;
    newPhone: string;
    code: string;
    secret: string;
    now?: Date;
  },
): Promise<{ userId: string; pendingUntil: Date }> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const row = await useToken(db, input.token, 'recover', now, false);
    if (!row) throw new OperationError('CODE_INVALID');
    const phone = normalisePhone(input.newPhone);
    if (!phone) throw new OperationError('INVALID_INPUT');
    const verified = await verifySignInCode(db, {
      phone,
      code: input.code,
      secret: input.secret,
      purpose: 'change_phone',
      now,
    });
    if (verified.status !== 'ok') throw new OperationError('CODE_INVALID');
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phoneE164, phone));
    if (owner) throw new OperationError('PHONE_TAKEN');
    const pendingUntil = new Date(now.getTime() + RECOVERY_HOLD_MS);
    const [user] = await db
      .select({ phone: users.phoneE164 })
      .from(users)
      .where(eq(users.id, row.userId));
    await db.transaction(async (tx) => {
      await tx.insert(phoneRecoveries).values({
        id: newId(),
        userId: row.userId,
        newPhoneE164: phone,
        effectiveAt: pendingUntil,
      });
      await tx
        .update(emailTokens)
        .set({ usedAt: now })
        .where(eq(emailTokens.tokenSha256, sha256(input.token)));
      const warning = `Someone asked to move your TipMe account to a new number ending ${phoneHint(phone)}. It happens in 24 hours. If this wasn’t you, sign in and cancel it in Settings.`;
      if (user?.phone)
        await writePretendMessage(tx, {
          channel: 'whatsapp',
          recipientHint: phoneHint(user.phone),
          userId: row.userId,
          body: warning,
        });
      await writePretendMessage(tx, {
        channel: 'email',
        recipientHint: maskEmail(row.email),
        userId: row.userId,
        subject: 'Your TipMe number is about to change',
        body: warning,
      });
    });
    return { userId: row.userId, pendingUntil };
  });
}

/** The owner cancels every pending recovery of their account (from any live session). */
export function cancelRecoveries(
  db: Database,
  userId: string,
): Promise<number> {
  return guarded(async () => {
    const cancelled = await db
      .update(phoneRecoveries)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(phoneRecoveries.userId, userId),
          isNull(phoneRecoveries.cancelledAt),
          isNull(phoneRecoveries.completedAt),
        ),
      )
      .returning({ id: phoneRecoveries.id });
    return cancelled.length;
  });
}

/** Pending recoveries of the user's account, for the "cancel" banner. */
export function pendingRecoveries(
  db: Database,
  userId: string,
): Promise<{ id: string; newPhoneHint: string; effectiveAt: string }[]> {
  return guarded(async () =>
    (
      await db
        .select()
        .from(phoneRecoveries)
        .where(
          and(
            eq(phoneRecoveries.userId, userId),
            isNull(phoneRecoveries.cancelledAt),
            isNull(phoneRecoveries.completedAt),
          ),
        )
    ).map((row) => ({
      id: row.id,
      newPhoneHint: phoneHint(row.newPhoneE164),
      effectiveAt: row.effectiveAt.toISOString(),
    })),
  );
}

/** Like confirmEmail, also naming the account (so its public page can be refreshed). */
export function confirmEmailForUser(
  db: Database,
  input: { token: string; now?: Date },
): Promise<{ status: 'confirmed' | 'invalid'; handle: string | null }> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const row = await useToken(db, input.token, 'verify', now, true);
    if (!row) return { status: 'invalid' as const, handle: null };
    await db
      .update(users)
      .set({ email: row.email, emailVerifiedAt: now })
      .where(eq(users.id, row.userId));
    const [page] = await db
      .select({ handle: profiles.handleLower })
      .from(profiles)
      .where(eq(profiles.userId, row.userId));
    return { status: 'confirmed' as const, handle: page?.handle ?? null };
  });
}
