import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';
import { nairaWhole, ngn } from '../money.js';

const minor = z.string().regex(/^\d+$/);

export const tipReceived = defineMailType({
  id: 'tip_received',
  category: 'transactional',
  preference: 'notify_tip_emails',
  schema: z
    .object({
      firstName: z.string().min(1).max(80),
      netMinor: minor,
      supporterLabel: z.string().max(80).nullable(),
      pretendPayment: z.boolean(),
    })
    .strict(),
  sample: {
    firstName: 'Ada',
    netMinor: '450000',
    supporterLabel: 'Tobi',
    pretendPayment: false,
  },
  render: (data, ctx) =>
    letter(
      {
        subject: `You got a ${nairaWhole(data.netMinor)} tip on TipMe`,
        heading: `${data.firstName}, you got a tip`,
        blocks: [
          {
            kind: 'text',
            text: `You got a tip of ${ngn(data.netMinor)} from ${data.supporterLabel ?? 'a guest'}. It is confirmed by the payment provider.${data.pretendPayment ? ' (Pretend payment: no real money moved.)' : ''}`,
          },
          {
            kind: 'button',
            label: 'See your tips',
            href: mailLink(ctx, '/dashboard/tips', 'see_tips'),
          },
        ],
        reason: 'You get this email when someone tips you on TipMe.',
      },
      ctx,
    ),
});
