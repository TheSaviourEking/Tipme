import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

const longDate = (isoDate: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));

/**
 * A business proposes a share of a staff member's tips there (business PR R2-C1). Percentages and
 * the start date only: never an amount. Nothing changes unless the person accepts on their Work page.
 */
export const shareProposed = defineMailType({
  id: 'share_proposed',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z
    .object({
      businessName: z.string().min(1).max(80),
      // The business's part: one of the options above 0, never more than the 50% cap.
      businessPercent: z.union([
        z.literal(10),
        z.literal(20),
        z.literal(30),
        z.literal(50),
      ]),
      startsOn: z.iso.date(),
    })
    .strict(),
  sample: {
    businessName: 'The Yellow Chilli',
    businessPercent: 10 as const,
    startsOn: '2026-12-01',
  },
  render: (data, ctx) =>
    letter(
      {
        subject: `${data.businessName} asks to keep ${data.businessPercent}% of the tips you get there`,
        heading: 'A business asks to share your tips',
        blocks: [
          {
            kind: 'text',
            text: `${data.businessName} asks to keep ${data.businessPercent}% of what you receive from tips there, after TipMe’s fee, from ${longDate(data.startsOn)}. You keep ${100 - data.businessPercent}%.`,
          },
          {
            kind: 'text',
            text: 'Nothing changes unless you accept. You can accept, decline or suggest another split on your Work page. If you decline, the business sees only that nothing changed. Tips through your own page, outside the business, are never shared.',
          },
          {
            kind: 'button',
            label: 'Go to your Work page',
            href: mailLink(ctx, '/dashboard/work', 'share_proposed'),
          },
        ],
        reason:
          'You get this email because a business you work at on TipMe proposed a share of your tips.',
      },
      ctx,
    ),
});
