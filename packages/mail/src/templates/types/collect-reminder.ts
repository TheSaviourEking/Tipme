import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';
import { naira } from '../money.js';

/**
 * You collect (plan Task 12, spec §2.1 step 3, §10): a recipient with tips waiting and no bank
 * details, reminded on the reminder days after their first waiting tip. The last reminder says when
 * the page pauses. The words are the spec's; the subject and preview name no amount or date.
 */
export const collectReminder = defineMailType({
  id: 'collect_reminder',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z
    .object({
      firstName: z.string().min(1).max(80),
      /** `waiting` on the earlier reminders, `last` on the one before the page pauses. */
      kind: z.enum(['waiting', 'last']),
      heldMinor: z.string().regex(/^\d+$/),
      /** The day the page pauses, as the Lagos calendar shows it ("20 December"). */
      byDate: z.string().min(1).max(40),
    })
    .strict(),
  sample: {
    firstName: 'Ada',
    kind: 'waiting',
    heldMinor: '1900000',
    byDate: '20 December',
  },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your tips are waiting for your bank details',
        heading: `${data.firstName}, add your bank details`,
        preheader: 'Add your bank details to withdraw your tips.',
        blocks: [
          {
            kind: 'text',
            text:
              data.kind === 'last'
                ? `Add your bank details by ${data.byDate}, or your page will pause new tips.`
                : `You have ${naira(data.heldMinor)} in tips waiting. Add your bank details to withdraw it.`,
          },
          {
            kind: 'button',
            label: 'Add bank details',
            href: mailLink(ctx, '/dashboard/withdraw', 'add_bank_details'),
          },
          { kind: 'quiet', text: 'Use a bank account in your own name.' },
        ],
        reason:
          'You get this email when tips are waiting for your bank details on TipMe.',
      },
      ctx,
    ),
});
