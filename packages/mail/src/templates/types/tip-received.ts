import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter, type Block } from '../layout.js';
import { naira } from '../money.js';

const minor = z.string().regex(/^\d+$/);

export const tipReceived = defineMailType({
  id: 'tip_received',
  category: 'transactional',
  sender: 'notifications',
  preference: 'notify_tip_emails',
  schema: z
    .object({
      firstName: z.string().min(1).max(80),
      netMinor: minor,
      supporterLabel: z.string().max(80).nullable(),
      pretendPayment: z.boolean(),
      // Optional: mail queued before these existed has neither.
      /** The tip has a note the recipient can read. Its words never come here. */
      hasNote: z.boolean().optional(),
      /** The policy's withdrawal minimum, passed by the trigger, never typed here. */
      minWithdrawalMinor: minor.optional(),
    })
    .strict(),
  sample: {
    firstName: 'Ada',
    netMinor: '450000',
    supporterLabel: 'Tobi',
    pretendPayment: false,
    hasNote: true,
    minWithdrawalMinor: '200000',
  },
  render: (data, ctx) => {
    const tips = mailLink(ctx, '/dashboard/tips', 'see_tips');
    const blocks: Block[] = [
      ...(data.hasNote
        ? [
            {
              kind: 'text' as const,
              text: `${data.supporterLabel ?? 'Your supporter'} left you a note.`,
            },
          ]
        : []),
      {
        kind: 'button',
        label: data.hasNote ? 'Read it on TipMe' : 'See your tips',
        href: tips,
      },
      {
        kind: 'quiet',
        text: `It is in your balance now.${data.minWithdrawalMinor ? ` You can withdraw from ${naira(data.minWithdrawalMinor)}.` : ''}`,
      },
      ...(data.pretendPayment
        ? [
            {
              kind: 'quiet' as const,
              text: 'Pretend payment: no real money moved.',
            },
          ]
        : []),
    ];
    return letter(
      {
        // The amount is the one private detail a subject carries (owner, 5 Nov 2026).
        subject: `You got a ${naira(data.netMinor)} tip on TipMe`,
        heading: `${data.firstName}, you got a tip.`,
        // Names nobody: the preview shows on lock screens.
        preheader:
          'Confirmed by our payment partner. It is in your balance now.',
        slab: {
          amount: naira(data.netMinor),
          line: `From ${data.supporterLabel ?? 'a guest'}. Confirmed by our payment partner.`,
        },
        blocks,
        reason: 'You get this email when someone tips you on TipMe.',
      },
      ctx,
    );
  },
});
