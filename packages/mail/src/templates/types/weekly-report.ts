import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';
import { ngn } from '../money.js';

export const weeklyReport = defineMailType({
  id: 'weekly_report',
  category: 'engagement',
  preference: 'notify_weekly_reports',
  schema: z
    .object({
      isoWeek: z.string().regex(/^\d{4}-W\d{2}$/),
      totalNetMinor: z.string().regex(/^\d+$/),
      tipCount: z.number().int().min(0),
    })
    .strict(),
  sample: { isoWeek: '2026-W43', totalNetMinor: '1250000', tipCount: 4 },
  render: (data, ctx) => {
    const summary = `${ngn(data.totalNetMinor)} from ${data.tipCount} ${data.tipCount === 1 ? 'tip' : 'tips'}`;
    return letter(
      {
        subject: 'Your week on TipMe',
        heading: 'Your week on TipMe',
        blocks: [
          { kind: 'text', text: `Your week (${data.isoWeek}): ${summary}.` },
          {
            kind: 'button',
            label: 'See the whole week',
            href: mailLink(ctx, '/dashboard/reports', 'open_report'),
          },
        ],
        reason:
          'You get a weekly report for weeks you were tipped. You can turn it off in your email settings.',
      },
      ctx,
    );
  },
});
