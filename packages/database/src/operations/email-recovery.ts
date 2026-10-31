import {
  and,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
} from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { emailRecoveries, sessions, users } from '../schema.js';
import { recordAudit } from './audit.js';
import { maskEmail, normaliseEmail } from './email-address.js';
import {
  checkEmailCode,
  issueEmailCode,
  verifiedOwner,
} from './email-sign-in.js';
import { RECOVERY_HOLD_MS } from './email.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';
import { enqueueMail, type MailSealing } from './mail-queue.js';
import { dropOpsAccess, isActiveStaff } from './staff.js';

/** How long after the old account is identified the new address may still be proven. */
const PROPOSAL_VALID_MS = 30 * 60_000;

/** Someone else signs in with this address, or already recovers with it. */
async function addressInUse(tx: Tx, email: string, userId: string) {
  const [signIn] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(verifiedOwner(email), ne(users.id, userId)));
  if (signIn) return true;
  const [recovery] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        sql`lower(${users.recoveryEmail}) = ${email}`,
        isNotNull(users.recoveryEmailVerifiedAt),
        isNull(users.deletedAt),
        ne(users.id, userId),
      ),
    );
  return Boolean(recovery);
}

/**
 * A code to the proposed recovery address. Whether it is in use is only said after the code
 * proves it is theirs, so this can't be used to find out who has an account.
 */
export function requestRecoveryEmailCode(
  db: Database,
  sealing: MailSealing,
  input: { userId: string; recoveryEmail: string; secret: string; now?: Date },
): Promise<
  'sent' | 'same_as_sign_in' | 'rate_limited' | 'locked' | 'bad_address'
> {
  const email = normaliseEmail(input.recoveryEmail);
  if (!email) return Promise.resolve('bad_address');
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [me] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, input.userId));
      if (me?.email?.toLowerCase() === email) return 'same_as_sign_in';
      return issueEmailCode(tx, sealing, {
        email,
        purpose: 'recovery_email',
        mailType: 'recovery_email_code',
        secret: input.secret,
        userId: input.userId,
        now,
      });
    }),
  );
}

/** A code to the sign-in email, needed to change or remove a confirmed recovery email. */
export function requestRecoveryChangeCode(
  db: Database,
  sealing: MailSealing,
  input: { userId: string; secret: string; now?: Date },
): Promise<'sent' | 'rate_limited' | 'locked' | 'no_email'> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [me] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, input.userId));
      if (!me?.email) return 'no_email';
      return issueEmailCode(tx, sealing, {
        email: me.email.toLowerCase(),
        purpose: 'recovery_email',
        mailType: 'recovery_change_code',
        secret: input.secret,
        userId: input.userId,
        now,
      });
    }),
  );
}

/**
 * Confirms a recovery email by the code sent to it. Replacing a confirmed one also needs a code
 * to the sign-in email, so a stolen session can't quietly take over the way back in.
 */
export function confirmRecoveryEmail(
  db: Database,
  input: {
    userId: string;
    recoveryEmail: string;
    code: string;
    secret: string;
    signInCode?: string;
    now?: Date;
  },
): Promise<
  'confirmed' | 'invalid' | 'needs_sign_in_code' | 'taken' | 'same_as_sign_in'
> {
  const email = normaliseEmail(input.recoveryEmail);
  if (!email) return Promise.resolve('invalid');
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [me] = await tx
        .select({
          email: users.email,
          confirmed: users.recoveryEmailVerifiedAt,
        })
        .from(users)
        .where(eq(users.id, input.userId))
        .for('update');
      if (!me) return 'invalid';
      if (me.email?.toLowerCase() === email) return 'same_as_sign_in';
      // Neither code is spent until both are right, so a typo in one doesn't kill the other.
      const checks = [{ email, code: input.code }];
      if (me.confirmed) {
        if (!input.signInCode || !me.email) return 'needs_sign_in_code';
        checks.push({ email: me.email.toLowerCase(), code: input.signInCode });
      }
      for (const check of checks) {
        const result = await checkEmailCode(tx, {
          ...check,
          purpose: 'recovery_email',
          secret: input.secret,
          now,
          keep: true,
        });
        if (result !== 'ok') return 'invalid';
      }
      if (await addressInUse(tx, email, input.userId)) return 'taken';
      for (const check of checks)
        await checkEmailCode(tx, {
          ...check,
          purpose: 'recovery_email',
          secret: input.secret,
          now,
        });
      await tx
        .update(users)
        .set({ recoveryEmail: email, recoveryEmailVerifiedAt: now })
        .where(eq(users.id, input.userId));
      return 'confirmed';
    }),
  );
}

export function removeRecoveryEmail(
  db: Database,
  input: { userId: string; signInCode: string; secret: string; now?: Date },
): Promise<'removed' | 'invalid'> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [me] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, input.userId))
        .for('update');
      if (!me?.email) return 'invalid';
      const owner = await checkEmailCode(tx, {
        email: me.email.toLowerCase(),
        purpose: 'recovery_email',
        code: input.signInCode,
        secret: input.secret,
        now,
      });
      if (owner !== 'ok') return 'invalid';
      await tx
        .update(users)
        .set({ recoveryEmail: null, recoveryEmailVerifiedAt: null })
        .where(eq(users.id, input.userId));
      return 'removed';
    }),
  );
}

/** For "Can't get into your email?". Always the same answer, whatever exists behind it. */
export function startEmailRecovery(
  db: Database,
  sealing: MailSealing,
  input: { signInEmail: string; secret: string; now?: Date },
): Promise<'sent'> {
  const email = normaliseEmail(input.signInEmail);
  if (!email) return Promise.resolve('sent');
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [owner] = await tx
        .select({
          id: users.id,
          recovery: users.recoveryEmail,
          confirmed: users.recoveryEmailVerifiedAt,
        })
        .from(users)
        .where(verifiedOwner(email));
      if (!owner?.recovery || !owner.confirmed) return 'sent' as const;
      // Staff accounts are never recovered by email (ADR-0010).
      if (await isActiveStaff(tx, owner.id)) return 'sent' as const;
      await issueEmailCode(tx, sealing, {
        email: owner.recovery.toLowerCase(),
        purpose: 'recovery',
        mailType: 'recovery_code',
        secret: input.secret,
        userId: owner.id,
        now,
      });
      return 'sent' as const;
    }),
  );
}

async function openProposal(
  tx: Tx,
  sealing: MailSealing,
  input: {
    userId: string;
    newEmail: string;
    startedBy: 'self' | 'staff';
    staffUserId?: string;
    secret: string;
    now: Date;
  },
) {
  // Only the latest proposal for an account stands.
  await tx
    .update(emailRecoveries)
    .set({ cancelledAt: input.now })
    .where(
      and(
        eq(emailRecoveries.userId, input.userId),
        isNull(emailRecoveries.confirmedAt),
        isNull(emailRecoveries.cancelledAt),
      ),
    );
  await tx.insert(emailRecoveries).values({
    id: newId(),
    userId: input.userId,
    newEmail: input.newEmail,
    startedBy: input.startedBy,
    staffUserId: input.staffUserId ?? null,
    createdAt: input.now,
  });
  return issueEmailCode(tx, sealing, {
    email: input.newEmail,
    purpose: 'recovery_new_email',
    mailType: 'recovery_new_email_code',
    secret: input.secret,
    userId: input.userId,
    now: input.now,
  });
}

const NEW_EMAIL_BUSY = new Error('new address cannot take a code');

/** The recovery code identifies the owner; next, a code proves the new address. */
export function proposeRecoveredEmail(
  db: Database,
  sealing: MailSealing,
  input: {
    signInEmail: string;
    recoveryCode: string;
    newEmail: string;
    secret: string;
    now?: Date;
  },
): Promise<'code_sent' | 'invalid' | 'bad_new_email' | 'new_email_busy'> {
  const email = normaliseEmail(input.signInEmail);
  const newEmail = normaliseEmail(input.newEmail);
  if (!email) return Promise.resolve('invalid');
  if (!newEmail) return Promise.resolve('bad_new_email');
  const now = input.now ?? new Date();
  return guarded(() =>
    db
      .transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: users.id, recovery: users.recoveryEmail })
          .from(users)
          .where(verifiedOwner(email));
        if (!owner?.recovery) return 'invalid';
        const checked = await checkEmailCode(tx, {
          email: owner.recovery.toLowerCase(),
          purpose: 'recovery',
          code: input.recoveryCode,
          secret: input.secret,
          now,
        });
        if (checked !== 'ok') return 'invalid';
        const sent = await openProposal(tx, sealing, {
          userId: owner.id,
          newEmail,
          startedBy: 'self',
          secret: input.secret,
          now,
        });
        // Rolls back: the recovery code still works, with a different address.
        if (sent !== 'sent') throw NEW_EMAIL_BUSY;
        return 'code_sent' as const;
      })
      .catch((error: unknown) => {
        if (error === NEW_EMAIL_BUSY) return 'new_email_busy' as const;
        throw error;
      }),
  );
}

/** The new address is proven: the 24-hour hold starts, and the old address is told. */
export function confirmRecoveredEmail(
  db: Database,
  sealing: MailSealing,
  input: {
    signInEmail: string;
    newEmail: string;
    code: string;
    secret: string;
    now?: Date;
  },
): Promise<
  | { status: 'pending'; effectiveAt: Date }
  | { status: 'invalid' }
  | { status: 'taken' }
> {
  const email = normaliseEmail(input.signInEmail);
  const newEmail = normaliseEmail(input.newEmail);
  if (!email || !newEmail) return Promise.resolve({ status: 'invalid' });
  const now = input.now ?? new Date();
  type Result =
    | { status: 'pending'; effectiveAt: Date }
    | { status: 'invalid' }
    | { status: 'taken' };
  return guarded(() =>
    db.transaction(async (tx): Promise<Result> => {
      const invalid: Result = { status: 'invalid' };
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(verifiedOwner(email));
      if (!owner) return invalid;
      const [proposal] = await tx
        .select({ id: emailRecoveries.id })
        .from(emailRecoveries)
        .where(
          and(
            eq(emailRecoveries.userId, owner.id),
            eq(emailRecoveries.newEmail, newEmail),
            isNull(emailRecoveries.confirmedAt),
            isNull(emailRecoveries.cancelledAt),
            gt(
              emailRecoveries.createdAt,
              new Date(now.getTime() - PROPOSAL_VALID_MS),
            ),
          ),
        )
        .orderBy(desc(emailRecoveries.createdAt))
        .limit(1)
        .for('update');
      if (!proposal) return invalid;
      const checked = await checkEmailCode(tx, {
        email: newEmail,
        purpose: 'recovery_new_email',
        code: input.code,
        secret: input.secret,
        now,
      });
      if (checked !== 'ok') return invalid;
      // The code has just proven the address is theirs, so this tells them nothing new.
      if (await addressInUse(tx, newEmail, owner.id))
        return { status: 'taken' };
      const effectiveAt = new Date(now.getTime() + RECOVERY_HOLD_MS);
      await tx
        .update(emailRecoveries)
        .set({ confirmedAt: now, effectiveAt })
        .where(eq(emailRecoveries.id, proposal.id));
      await enqueueMail(tx, sealing, {
        type: 'recovery_started_notice',
        to: email,
        userId: owner.id,
        data: { newEmailHint: maskEmail(newEmail) },
        dedupeKey: `recovery_started_notice.${proposal.id}`,
        now,
      });
      return { status: 'pending', effectiveAt };
    }),
  );
}

/** Staff, after checking who someone is. The new address must still be proven by its owner. */
export function startStaffRecovery(
  db: Database,
  sealing: MailSealing,
  input: {
    staffUserId: string;
    userId: string;
    newEmail: string;
    checks: string;
    reason: string;
    secret: string;
    now?: Date;
  },
): Promise<'code_sent' | 'staff_account' | 'not_found' | 'invalid'> {
  const newEmail = normaliseEmail(input.newEmail);
  if (!newEmail) return Promise.resolve('invalid');
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [account] = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(and(eq(users.id, input.userId), isNull(users.deletedAt)));
      if (!account?.email) return 'not_found';
      if (await isActiveStaff(tx, account.id)) return 'staff_account';
      const sent = await openProposal(tx, sealing, {
        userId: account.id,
        newEmail,
        startedBy: 'staff',
        staffUserId: input.staffUserId,
        secret: input.secret,
        now,
      });
      if (sent !== 'sent') return 'invalid';
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'account.staff_recovery_started',
        permission: 'recoveries.manage',
        subjectType: 'user',
        subjectId: account.id,
        reason: `${input.reason} Checks: ${input.checks}`,
        now,
      });
      return 'code_sent';
    }),
  );
}

/** Scheduled. Moves accounts whose hold has ended, unless the address was taken meanwhile. */
export function completeDueRecoveries(
  db: Database,
  sealing: MailSealing,
  now: Date,
): Promise<number> {
  return guarded(async () => {
    const due = await db
      .select({ id: emailRecoveries.id })
      .from(emailRecoveries)
      .where(
        and(
          lte(emailRecoveries.effectiveAt, now),
          isNull(emailRecoveries.completedAt),
          isNull(emailRecoveries.cancelledAt),
        ),
      )
      .limit(100);
    let completed = 0;
    for (const { id } of due) {
      const moved = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(emailRecoveries)
          .where(
            and(
              eq(emailRecoveries.id, id),
              isNull(emailRecoveries.completedAt),
              isNull(emailRecoveries.cancelledAt),
            ),
          )
          .for('update');
        if (!row) return false;
        if (await addressInUse(tx, row.newEmail, row.userId)) {
          await tx
            .update(emailRecoveries)
            .set({ cancelledAt: now })
            .where(eq(emailRecoveries.id, id));
          return false;
        }
        const [me] = await tx
          .select({ email: users.email, recovery: users.recoveryEmail })
          .from(users)
          .where(eq(users.id, row.userId))
          .for('update');
        await tx
          .update(users)
          .set({
            email: row.newEmail,
            emailVerifiedAt: now,
            ...(me?.recovery?.toLowerCase() === row.newEmail
              ? { recoveryEmail: null, recoveryEmailVerifiedAt: null }
              : {}),
          })
          .where(eq(users.id, row.userId));
        await tx
          .update(emailRecoveries)
          .set({ completedAt: now })
          .where(eq(emailRecoveries.id, id));
        await tx
          .update(sessions)
          .set({ revokedAt: now })
          .where(
            and(eq(sessions.userId, row.userId), isNull(sessions.revokedAt)),
          );
        const wasStaff = await isActiveStaff(tx, row.userId);
        await dropOpsAccess(tx, row.userId, now);
        if (wasStaff)
          await enqueueMail(tx, sealing, {
            type: 'staff_access_notice',
            to: row.newEmail,
            userId: row.userId,
            data: { change: 'removed' },
            dedupeKey: `staff_access_notice.${row.userId}.${now.getTime()}`,
            now,
          });
        const data = { newEmailHint: maskEmail(row.newEmail) };
        await enqueueMail(tx, sealing, {
          type: 'recovery_completed_notice',
          to: row.newEmail,
          userId: row.userId,
          data,
          dedupeKey: `recovery_completed_notice.new.${id}`,
          now,
        });
        if (me?.email)
          await enqueueMail(tx, sealing, {
            type: 'recovery_completed_notice',
            to: me.email,
            userId: row.userId,
            data,
            dedupeKey: `recovery_completed_notice.old.${id}`,
            now,
          });
        return true;
      });
      if (moved) completed += 1;
    }
    return completed;
  });
}

/** The owner stops every recovery of their account, from any signed-in session. */
export function cancelEmailRecoveries(
  db: Database,
  userId: string,
): Promise<number> {
  return guarded(async () => {
    const rows = await db
      .update(emailRecoveries)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(emailRecoveries.userId, userId),
          isNull(emailRecoveries.cancelledAt),
          isNull(emailRecoveries.completedAt),
        ),
      )
      .returning({ id: emailRecoveries.id });
    return rows.length;
  });
}

/** Proven recoveries waiting out their hold, for the "cancel" banner. */
export function pendingEmailRecoveries(
  db: Database,
  userId: string,
): Promise<{ id: string; newEmailHint: string; effectiveAt: string }[]> {
  return guarded(async () =>
    (
      await db
        .select()
        .from(emailRecoveries)
        .where(
          and(
            eq(emailRecoveries.userId, userId),
            isNotNull(emailRecoveries.confirmedAt),
            isNull(emailRecoveries.cancelledAt),
            isNull(emailRecoveries.completedAt),
          ),
        )
    ).map((row) => ({
      id: row.id,
      newEmailHint: maskEmail(row.newEmail),
      effectiveAt: row.effectiveAt!.toISOString(),
    })),
  );
}

export async function needsRecoveryEmail(
  db: Database,
  userId: string,
): Promise<boolean> {
  const [me] = await db
    .select({ confirmed: users.recoveryEmailVerifiedAt })
    .from(users)
    .where(eq(users.id, userId));
  return !me?.confirmed;
}

/** The confirmed recovery email, or null. */
export async function recoveryEmailOf(
  db: Database,
  userId: string,
): Promise<string | null> {
  const [me] = await db
    .select({
      email: users.recoveryEmail,
      confirmed: users.recoveryEmailVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  return me?.confirmed ? me.email : null;
}
