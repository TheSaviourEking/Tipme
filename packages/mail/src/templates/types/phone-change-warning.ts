import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

/** Retired with phone recovery (Part 6). */
export const phoneChangeWarning = defineMailType({
  id: 'phone_change_warning',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z.object({ newPhoneHint: z.string().min(1).max(32) }).strict(),
  sample: { newPhoneHint: '•••4821' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your TipMe number is about to change',
        heading: 'Your number changes in 24 hours',
        tag: 'safety',
        // The number's digits are private; the preview line must not show them.
        preheader: 'It happens in 24 hours.',
        blocks: [
          {
            kind: 'text',
            text: `Someone asked to move your TipMe account to a new number ending ${data.newPhoneHint}.`,
          },
          {
            kind: 'alarm',
            title: 'Wasn’t you?',
            text: 'Sign in and cancel it in Settings before it happens.',
          },
          {
            kind: 'button',
            label: 'Sign in to cancel',
            href: mailLink(ctx, '/dashboard/settings', 'cancel_phone_change'),
          },
        ],
        reason:
          'You get this email because a number change was requested on your TipMe account.',
      },
      ctx,
    ),
});
