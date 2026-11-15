import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const monthName = (month: string) =>
  `${MONTHS[Number(month.slice(5, 7)) - 1] ?? ''} ${month.slice(0, 4)}`;

/**
 * A Pro page's monthly recap is ready (ProAdditions §5). It goes through the same "reports"
 * switch as the weekly email, so turning that off stops both. The subject and preview line say
 * nothing about the month's numbers; the body has the tip count only, never an amount or a name.
 */
export const monthlyRecap = defineMailType({
  id: 'monthly_recap',
  category: 'engagement',
  sender: 'reports',
  preference: 'notify_weekly_reports',
  schema: z
    .object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      tipCount: z.number().int().min(0),
    })
    .strict(),
  sample: { month: '2026-10', tipCount: 41 },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your monthly recap is ready',
        heading: 'Your month on TipMe',
        preheader: 'See it and share it if you like.',
        blocks: [
          {
            kind: 'text',
            text: `${monthName(data.month)}: ${data.tipCount} ${data.tipCount === 1 ? 'tip' : 'tips'}.`,
          },
          {
            kind: 'button',
            label: 'See your recap',
            href: mailLink(
              ctx,
              `/dashboard/reports/month/${data.month}`,
              'open_recap',
            ),
          },
        ],
        reason:
          'You get this email on the 1st of the month while you’re on TipMe Pro and were tipped last month. Turn it off with your report emails in Settings.',
      },
      ctx,
    ),
});
