import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { MAIL_TYPES } from '@tipme/mail';
import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { mailPreferences, profiles } from '../schema.js';
import { guarded } from './errors.js';
import type { MailSealing } from './mail-queue.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Mail a person can turn off: its own switch, or the guides (engagement) or marketing ones. */
export function canUnsubscribe(type: string): boolean {
  const mail = MAIL_TYPES[type];
  if (!mail) return false;
  return (
    mail.preference !== null ||
    mail.category === 'engagement' ||
    mail.category === 'marketing'
  );
}

const keyOf = (sealing: MailSealing) =>
  Buffer.from(hkdfSync('sha256', sealing.key, '', 'mail-unsubscribe', 32));

const signatureOf = (sealing: MailSealing, body: string) =>
  createHmac('sha256', keyOf(sealing)).update(body).digest('hex').slice(0, 32);

/** For the link and List-Unsubscribe header: who and which type, signed. It never expires. */
export function unsubscribeToken(
  sealing: MailSealing,
  input: { userId: string; type: string },
): string {
  const body = Buffer.from(`${input.userId}:${input.type}`).toString(
    'base64url',
  );
  return `${body}.${signatureOf(sealing, body)}`;
}

export function readUnsubscribeToken(
  sealing: MailSealing,
  token: string,
): { userId: string; type: string } | null {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(signatureOf(sealing, body));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  const [userId = '', type = ''] = Buffer.from(body, 'base64url')
    .toString()
    .split(':');
  if (!UUID.test(userId) || !canUnsubscribe(type)) return null;
  return { userId, type };
}

/** Turns off the type's own switch, or the category's for a type without one. */
export function applyUnsubscribe(
  db: Database,
  input: { userId: string; type: string },
): Promise<'done' | 'not_applicable'> {
  const mail = MAIL_TYPES[input.type];
  if (!mail || !canUnsubscribe(input.type))
    return Promise.resolve('not_applicable');
  return guarded(async () => {
    if (mail.preference) {
      const column = {
        notify_tip_emails: { notifyTipEmails: false },
        notify_weekly_reports: { notifyWeeklyReports: false },
        notify_milestones: { notifyMilestones: false },
      }[mail.preference];
      await db
        .update(profiles)
        .set(column)
        .where(eq(profiles.userId, input.userId));
      return 'done' as const;
    }
    const off =
      mail.category === 'marketing'
        ? { marketing: false }
        : { engagement: false };
    await db
      .insert(mailPreferences)
      .values({ userId: input.userId, ...off })
      .onConflictDoUpdate({
        target: mailPreferences.userId,
        set: { ...off, updatedAt: new Date() },
      });
    return 'done' as const;
  });
}
