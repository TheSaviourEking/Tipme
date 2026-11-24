import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

/**
 * You collect (plan Task 13, ruling P12, spec §10 "Verified"): our payment partner matched the
 * recipient's name with their bank's, and the account can receive, so their tips are on their way.
 * Sent once, when the bank details are verified. It names no bank, number or name.
 */
export const collectVerified = defineMailType({
  id: 'collect_verified',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z.object({ firstName: z.string().min(1).max(80) }).strict(),
  sample: { firstName: 'Ada' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your bank details are verified',
        heading: `${data.firstName}, you're all set`,
        preheader: 'Your tips are on their way to you.',
        blocks: [
          {
            kind: 'text',
            text: 'You’re all set. Your tips are on their way to you.',
          },
          {
            kind: 'button',
            label: 'Go to your dashboard',
            href: mailLink(ctx, '/dashboard', 'collect_verified'),
          },
          {
            kind: 'quiet',
            text: 'If you didn’t add these bank details, contact support@usetipme.xyz now.',
          },
        ],
        reason:
          'You get this email when the bank details on your TipMe account are verified.',
      },
      ctx,
    ),
});
