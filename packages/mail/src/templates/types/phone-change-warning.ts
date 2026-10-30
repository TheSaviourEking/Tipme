import { z } from 'zod';
import { defineMailType } from '../define.js';
import { letter } from '../layout.js';

/** Retired with phone recovery (Part 6). */
export const phoneChangeWarning = defineMailType({
  id: 'phone_change_warning',
  category: 'security',
  preference: null,
  schema: z.object({ newPhoneHint: z.string().min(1).max(32) }).strict(),
  sample: { newPhoneHint: '•••4821' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your TipMe number is about to change',
        heading: 'Your TipMe number is about to change',
        blocks: [
          {
            kind: 'text',
            text: `Someone asked to move your TipMe account to a new number ending ${data.newPhoneHint}. It happens in 24 hours. If this wasn’t you, sign in and cancel it in Settings.`,
          },
        ],
        reason:
          'You get this email because a recovery was started for your TipMe account.',
      },
      ctx,
    ),
});
