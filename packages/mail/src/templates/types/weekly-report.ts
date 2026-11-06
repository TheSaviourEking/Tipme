import { z } from 'zod';
import { weekDays } from '../dates.js';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';
import { naira } from '../money.js';

export const weeklyReport = defineMailType({
  id: 'weekly_report',
  category: 'engagement',
  sender: 'reports',
  preference: 'notify_weekly_reports',
  schema: z
    .object({
      isoWeek: z.string().regex(/^\d{4}-W\d{2}$/),
      totalNetMinor: z.string().regex(/^\d+$/),
      tipCount: z.number().int().min(0),
    })
    .strict(),
  sample: { isoWeek: '2026-W43', totalNetMinor: '1250000', tipCount: 4 },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your week on TipMe',
        heading: 'Your week on TipMe',
        // The first text is the week; the preview line says what to do instead.
        preheader: 'See the whole week.',
        blocks: [
          { kind: 'text', text: `${weekDays(data.isoWeek)}.` },
          {
            kind: 'stats',
            items: [
              { value: naira(data.totalNetMinor), label: 'you received' },
              {
                value: String(data.tipCount),
                label: data.tipCount === 1 ? 'tip' : 'tips',
              },
            ],
          },
          {
            kind: 'button',
            label: 'See the whole week',
            href: mailLink(ctx, '/dashboard/reports', 'open_report'),
          },
        ],
        reason:
          'You get this email every Monday when you were tipped last week.',
      },
      ctx,
    ),
});
