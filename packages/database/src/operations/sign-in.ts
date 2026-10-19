import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  phoneRecoveries,
  sessions,
  signInCodes,
  signInLockouts,
  users,
} from '../schema.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';
import { normalisePhone, phoneHint } from './phone.js';
import { writePretendMessage } from './pretend-outbox.js';
import { dropOpsAccess } from './staff.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODES_PER_HOUR = 3;
export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export type CodePurpose = 'sign_in' | 'change_phone';

const hmacOf = (secret: string, phone: string, purpose: string, code: string) =>
  createHmac('sha256', secret)
    .update(`${phone}:${purpose}:${code}`)
    .digest('hex');

const sameHex = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function lockedUntil(
  tx: Database | Tx,
  phone: string,
  now: Date,
): Promise<Date | null> {
  const [row] = await tx
    .select({ lockedUntil: signInLockouts.lockedUntil })
    .from(signInLockouts)
    .where(eq(signInLockouts.phoneE164, phone));
  return row?.lockedUntil && row.lockedUntil > now ? row.lockedUntil : null;
}

/**
 * Sends a 6-digit code (WhatsApp, then SMS when WhatsApp fails) through the pretend messenger.
 * The answer is the same whether or not the number has an account. An invalid number is
 * answered as `sent` too, and nothing is stored.
 */
export function requestSignInCode(
  db: Database,
  input: {
    phone: string;
    secret: string;
    purpose?: CodePurpose;
    now?: Date;
    simulateWhatsappFailure?: boolean;
  },
): Promise<{ status: 'sent' | 'rate_limited' | 'locked' }> {
  const now = input.now ?? new Date();
  const purpose = input.purpose ?? 'sign_in';
  const phone = normalisePhone(input.phone);
  return guarded(() =>
    db.transaction(async (tx) => {
      if (!phone) return { status: 'sent' as const };
      if (await lockedUntil(tx, phone, now))
        return { status: 'locked' as const };
      const [recent] = await tx
        .select({ n: count() })
        .from(signInCodes)
        .where(
          and(
            eq(signInCodes.phoneE164, phone),
            gte(signInCodes.createdAt, new Date(now.getTime() - 3_600_000)),
          ),
        );
      if ((recent?.n ?? 0) >= CODES_PER_HOUR)
        return { status: 'rate_limited' as const };
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await tx.insert(signInCodes).values({
        id: newId(),
        phoneE164: phone,
        codeHmac: hmacOf(input.secret, phone, purpose, code),
        purpose,
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
        createdAt: now,
      });
      const body = `Your TipMe code is ${code}. It expires in 10 minutes. Never share it with anyone.`;
      await writePretendMessage(tx, {
        channel: 'whatsapp',
        recipientHint: phoneHint(phone),
        body,
      });
      if (input.simulateWhatsappFailure)
        await writePretendMessage(tx, {
          channel: 'sms',
          recipientHint: phoneHint(phone),
          body,
        });
      return { status: 'sent' as const };
    }),
  );
}

export type VerifyResult =
  | { status: 'ok'; userId: string; created: boolean }
  | { status: 'invalid' | 'expired' | 'locked' | 'pending_recovery' };

/**
 * Checks a code against the latest unused one for the number. Wrong codes count towards a
 * 15-minute lockout after five. A correct sign-in code creates the account the first time.
 */
export function verifySignInCode(
  db: Database,
  input: {
    phone: string;
    code: string;
    secret: string;
    purpose?: CodePurpose;
    now?: Date;
  },
): Promise<VerifyResult> {
  const now = input.now ?? new Date();
  const purpose = input.purpose ?? 'sign_in';
  const phone = normalisePhone(input.phone);
  return guarded(() =>
    db.transaction(async (tx): Promise<VerifyResult> => {
      if (!phone || !/^\d{6}$/.test(input.code)) return { status: 'invalid' };
      if (await lockedUntil(tx, phone, now)) return { status: 'locked' };
      const [latest] = await tx
        .select()
        .from(signInCodes)
        .where(
          and(
            eq(signInCodes.phoneE164, phone),
            eq(signInCodes.purpose, purpose),
          ),
        )
        .orderBy(desc(signInCodes.createdAt))
        .limit(1)
        .for('update');
      const matches =
        latest !== undefined &&
        latest.consumedAt === null &&
        sameHex(
          latest.codeHmac,
          hmacOf(input.secret, phone, purpose, input.code),
        );
      if (!matches) return failure(tx, phone, now);
      if (latest.expiresAt <= now) return { status: 'expired' };
      await tx
        .update(signInCodes)
        .set({ consumedAt: now })
        .where(eq(signInCodes.id, latest.id));
      await tx
        .insert(signInLockouts)
        .values({ phoneE164: phone, failures: 0 })
        .onConflictDoUpdate({
          target: signInLockouts.phoneE164,
          set: { failures: 0, lockedUntil: null },
        });
      if (purpose !== 'sign_in')
        return { status: 'ok', userId: '', created: false };
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.phoneE164, phone), isNull(users.deletedAt)));
      if (owner) return { status: 'ok', userId: owner.id, created: false };
      // A number waiting to be attached by an email recovery: not before the hold ends.
      const [recovery] = await tx
        .select()
        .from(phoneRecoveries)
        .where(
          and(
            eq(phoneRecoveries.newPhoneE164, phone),
            isNull(phoneRecoveries.cancelledAt),
            isNull(phoneRecoveries.completedAt),
          ),
        )
        .orderBy(desc(phoneRecoveries.createdAt))
        .limit(1)
        .for('update');
      if (recovery) {
        if (recovery.effectiveAt > now) return { status: 'pending_recovery' };
        const [account] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, recovery.userId), isNull(users.deletedAt)));
        await tx
          .update(phoneRecoveries)
          .set({ completedAt: now })
          .where(eq(phoneRecoveries.id, recovery.id));
        if (account) {
          await tx
            .update(users)
            .set({ phoneE164: phone })
            .where(eq(users.id, account.id));
          await dropOpsAccess(tx, account.id, now);
          await tx
            .update(sessions)
            .set({ revokedAt: now })
            .where(
              and(eq(sessions.userId, account.id), isNull(sessions.revokedAt)),
            );
          return { status: 'ok', userId: account.id, created: false };
        }
      }
      const inserted = await tx
        .insert(users)
        .values({ id: newId(), phoneE164: phone })
        .onConflictDoNothing({ target: users.phoneE164 })
        .returning({ id: users.id });
      if (inserted[0])
        return { status: 'ok', userId: inserted[0].id, created: true };
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.phoneE164, phone), isNull(users.deletedAt)));
      if (!existing) return { status: 'invalid' };
      return { status: 'ok', userId: existing.id, created: false };
    }),
  );
}

async function failure(
  tx: Tx,
  phone: string,
  now: Date,
): Promise<VerifyResult> {
  const [row] = await tx
    .insert(signInLockouts)
    .values({ phoneE164: phone, failures: 1 })
    .onConflictDoUpdate({
      target: signInLockouts.phoneE164,
      set: { failures: sql`${signInLockouts.failures} + 1` },
    })
    .returning({ failures: signInLockouts.failures });
  if ((row?.failures ?? 0) < MAX_FAILURES) return { status: 'invalid' };
  await tx
    .update(signInLockouts)
    .set({ failures: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) })
    .where(eq(signInLockouts.phoneE164, phone));
  return { status: 'locked' };
}
