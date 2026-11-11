import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';
import { naira } from '../money.js';

/*
 * Paid Pro (ADR-0015; the owner's decisions of 5 and 9 Nov 2026). Account mail that can't be
 * turned off: it is about something the person pays for. No amount in a subject or preview line,
 * and the payment partner is never named.
 */

// A Lagos date written out, as lagosDateWords makes it: "9 December 2026".
const date = z.string().regex(/^\d{1,2} [A-Z][a-z]+ \d{4}$/);
const REASON = 'You get this email because your TipMe page is on Pro.';

const renewButton = (ctx: Parameters<typeof mailLink>[0]) => ({
  kind: 'button' as const,
  label: 'Renew Pro',
  href: mailLink(ctx, '/dashboard/settings#plan', 'renew_pro'),
});

export const proRenewalReminder = defineMailType({
  id: 'pro_renewal_reminder',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z
    .object({
      daysLeft: z.union([z.literal(7), z.literal(1)]),
      endDate: date,
      graceEndDate: date,
      /** The server's current price for a new month, in kobo; absent if none is set. */
      priceMinor: z
        .string()
        .regex(/^[1-9][0-9]{0,11}$/)
        .optional(),
    })
    .strict(),
  sample: {
    daysLeft: 7,
    endDate: '9 December 2026',
    graceEndDate: '12 December 2026',
    priceMinor: '250000',
  },
  render: (data, ctx) =>
    letter(
      {
        subject:
          data.daysLeft === 1
            ? 'Your TipMe Pro month ends tomorrow'
            : 'Your TipMe Pro month ends soon',
        heading:
          data.daysLeft === 1 ? 'Pro ends tomorrow' : 'Pro ends in a week',
        preheader: 'Renew to keep your Pro page as it is.',
        blocks: [
          {
            kind: 'text',
            text: `Your Pro month ends on ${data.endDate}${data.daysLeft === 1 ? ', tomorrow' : ''}. Renew to keep your Pro page as it is.`,
          },
          ...(data.priceMinor
            ? [
                {
                  kind: 'text' as const,
                  text: `A new month is ${naira(data.priceMinor)} a month, paid by card or bank transfer through our payment partner.`,
                },
              ]
            : []),
          {
            kind: 'quiet',
            text: `If you don’t renew, your page keeps Pro until ${data.graceEndDate}, then moves to Free. Nothing is deleted.`,
          },
          renewButton(ctx),
        ],
        reason: REASON,
      },
      ctx,
    ),
});

export const proGraceStarted = defineMailType({
  id: 'pro_grace_started',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z.object({ graceEndDate: date }).strict(),
  sample: { graceEndDate: '12 December 2026' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your TipMe Pro month has ended',
        heading: 'Your Pro month has ended',
        preheader: 'Renew within 3 days to keep Pro.',
        blocks: [
          {
            kind: 'text',
            text: `Your page keeps Pro until ${data.graceEndDate}. Renew before then to keep it, with no gap.`,
          },
          {
            kind: 'quiet',
            text: 'After that your page moves to Free. Nothing is deleted, and it all comes back when you renew.',
          },
          renewButton(ctx),
        ],
        reason: REASON,
      },
      ctx,
    ),
});

export const proEnded = defineMailType({
  id: 'pro_ended',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z.object({}).strict(),
  sample: {},
  render: (_data, ctx) =>
    letter(
      {
        subject: 'Your TipMe page is on Free now',
        heading: 'Your page is on Free',
        preheader: 'Nothing is deleted.',
        blocks: [
          {
            kind: 'text',
            text: 'Your Pro month and its grace have ended, so your page now shows the Free version.',
          },
          {
            kind: 'quiet',
            text: 'Nothing is deleted: your links, amounts and designs are kept, and show again when you go back to Pro.',
          },
          {
            kind: 'button',
            label: 'Go back to Pro',
            href: mailLink(ctx, '/dashboard/settings#plan', 'back_to_pro'),
          },
        ],
        reason:
          'You get this email because your TipMe page was on Pro until today.',
      },
      ctx,
    ),
});

const PAID_BY_WORDS = {
  card: 'card through our payment partner',
  bank_transfer: 'bank transfer through our payment partner',
  balance: 'your TipMe balance',
  saved_card: 'your saved card, through our payment partner',
} as const;

/**
 * Auto-renew (plan Task 10): the saved card was refused or couldn't be charged. Pro carries on to
 * the end of the month and its grace as usual; renewing by hand still works.
 */
export const proRenewalFailed = defineMailType({
  id: 'pro_renewal_failed',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z.object({ endDate: date, graceEndDate: date }).strict(),
  sample: { endDate: '9 December 2026', graceEndDate: '12 December 2026' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your TipMe Pro didn’t renew',
        heading: 'Pro didn’t renew',
        preheader: 'Your saved card didn’t go through. Renew to keep Pro.',
        blocks: [
          {
            kind: 'text',
            text: `We tried to renew Pro on your saved card, but the payment didn’t go through. Your Pro month ends on ${data.endDate}.`,
          },
          {
            kind: 'quiet',
            text: `You can renew by card or bank transfer. If you don’t, your page keeps Pro until ${data.graceEndDate}, then moves to Free. Nothing is deleted. We won’t try the card again for this month.`,
          },
          renewButton(ctx),
        ],
        reason: REASON,
      },
      ctx,
    ),
});

/** TipMe's own receipt for a Pro month (the partner sends none for TipMe's own sales). */
export const proReceipt = defineMailType({
  id: 'pro_receipt',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z
    .object({
      amountMinor: z.string().regex(/^[1-9][0-9]{0,11}$/),
      paidBy: z.enum(['card', 'bank_transfer', 'balance', 'saved_card']),
      startDate: date,
      endDate: date,
      /** The purchase's short reference, to quote to support. */
      purchaseRef: z.string().regex(/^[0-9a-f]{8}$/),
    })
    .strict(),
  sample: {
    amountMinor: '250000',
    paidBy: 'card',
    startDate: '9 November 2026',
    endDate: '9 December 2026',
    purchaseRef: 'c0de1234',
  },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your TipMe Pro receipt',
        heading: 'Thank you for Pro',
        preheader: 'Your Pro month is confirmed.',
        blocks: [
          {
            kind: 'text',
            text: 'Your payment is confirmed and your page is on Pro.',
          },
          {
            kind: 'facts',
            rows: [
              { label: 'Plan', value: 'TipMe Pro, one month' },
              {
                label: 'Period',
                value: `${data.startDate} to ${data.endDate}`,
              },
              { label: 'Amount', value: naira(data.amountMinor) },
              {
                label: 'Paid by',
                value: PAID_BY_WORDS[data.paidBy as keyof typeof PAID_BY_WORDS],
              },
              { label: 'Reference', value: data.purchaseRef },
            ],
          },
          {
            kind: 'quiet',
            text:
              data.paidBy === 'saved_card'
                ? 'Keep this email as your receipt. Pro renewed automatically on your saved card. To stop it, choose Turn off auto-renew in Settings, Plan.'
                : 'Keep this email as your receipt. Pro doesn’t renew by itself: we’ll remind you before the month ends.',
          },
        ],
        reason: 'You get this email because you paid for TipMe Pro.',
      },
      ctx,
    ),
});
