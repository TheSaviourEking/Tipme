import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';
import { ngn } from '../money.js';

const minor = z.string().regex(/^\d+$/);

export const staffAccessNotice = defineMailType({
  id: 'staff_access_notice',
  category: 'security',
  preference: null,
  schema: z.object({ change: z.enum(['granted', 'removed']) }).strict(),
  sample: { change: 'granted' },
  render: (data, ctx) =>
    letter(
      {
        subject:
          data.change === 'granted'
            ? 'You now have TipMe staff access'
            : 'Your TipMe staff access was removed',
        heading:
          data.change === 'granted'
            ? 'You have staff access'
            : 'Your staff access was removed',
        blocks: [
          {
            kind: 'text',
            text:
              data.change === 'granted'
                ? 'This account can now use the TipMe admin area. If you weren’t expecting this, reply to this email straight away.'
                : 'This account can no longer use the TipMe admin area, and any admin session was ended. If you weren’t expecting this, reply to this email.',
          },
        ],
        reason:
          'You get this email when the staff access on your account changes.',
      },
      ctx,
    ),
});

export const accountDeletedNotice = defineMailType({
  id: 'account_deleted_notice',
  category: 'security',
  preference: null,
  schema: z.object({}).strict(),
  sample: {},
  render: (_data, ctx) =>
    letter(
      {
        subject: 'Your TipMe account was deleted',
        heading: 'Your account was deleted',
        blocks: [
          {
            kind: 'text',
            text: 'Your TipMe account and page are gone. This is the last email we’ll send you. If you didn’t do this, reply to this email straight away.',
          },
        ],
        reason: 'You get this email because your TipMe account was deleted.',
      },
      ctx,
    ),
});

export const paymentAccountReady = defineMailType({
  id: 'payment_account_ready',
  category: 'account',
  preference: null,
  schema: z.object({}).strict(),
  sample: {},
  render: (_data, ctx) =>
    letter(
      {
        subject: 'You can receive tips on TipMe now',
        heading: 'You can receive tips now',
        blocks: [
          {
            kind: 'text',
            text: 'Your payment account is ready, so people can tip you. Share your link to get your first one.',
          },
          {
            kind: 'button',
            label: 'Go to your dashboard',
            href: mailLink(ctx, '/dashboard', 'dashboard'),
          },
        ],
        reason: 'You get this email when your payment account becomes ready.',
      },
      ctx,
    ),
});

export const paymentAccountActionNeeded = defineMailType({
  id: 'payment_account_action_needed',
  category: 'account',
  preference: null,
  schema: z.object({}).strict(),
  sample: {},
  render: (_data, ctx) =>
    letter(
      {
        subject: 'Your TipMe payment account needs attention',
        heading: 'Your payment account needs attention',
        blocks: [
          {
            kind: 'text',
            text: 'Our payment provider needs something from you. You may not be able to receive tips until it’s sorted.',
          },
          {
            kind: 'button',
            label: 'Check your payment account',
            href: mailLink(ctx, '/dashboard/settings', 'settings'),
          },
        ],
        reason:
          'You get this email when your payment account is restricted or needs information.',
      },
      ctx,
    ),
});

export const pagePaused = defineMailType({
  id: 'page_paused',
  category: 'account',
  preference: null,
  schema: z.object({}).strict(),
  sample: {},
  render: (_data, ctx) =>
    letter(
      {
        subject: 'Your TipMe page was paused',
        heading: 'Your page was paused',
        blocks: [
          {
            kind: 'text',
            text: 'TipMe staff paused your page, so it isn’t taking new tips. Tips already on their way still settle. Reply to this email to find out more.',
          },
        ],
        reason: 'You get this email when staff pause your page.',
      },
      ctx,
    ),
});

export const pageRestored = defineMailType({
  id: 'page_restored',
  category: 'account',
  preference: null,
  schema: z.object({}).strict(),
  sample: {},
  render: (_data, ctx) =>
    letter(
      {
        subject: 'Your TipMe page is back',
        heading: 'Your page is back',
        blocks: [
          {
            kind: 'text',
            text: 'TipMe staff restored your page, and it can take tips again.',
          },
          {
            kind: 'button',
            label: 'Go to your dashboard',
            href: mailLink(ctx, '/dashboard', 'dashboard'),
          },
        ],
        reason: 'You get this email when staff restore your page.',
      },
      ctx,
    ),
});

export const withdrawalPaid = defineMailType({
  id: 'withdrawal_paid',
  category: 'transactional',
  preference: null,
  schema: z.object({ amountMinor: minor }).strict(),
  sample: { amountMinor: '250000' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your TipMe withdrawal was paid',
        heading: 'Your withdrawal was paid',
        blocks: [
          {
            kind: 'text',
            text: `We paid out ${ngn(data.amountMinor)}. The payment provider confirmed it.`,
          },
        ],
        reason: 'You get this email for each withdrawal from your balance.',
      },
      ctx,
    ),
});

export const withdrawalFailed = defineMailType({
  id: 'withdrawal_failed',
  category: 'transactional',
  preference: null,
  schema: z.object({ amountMinor: minor }).strict(),
  sample: { amountMinor: '250000' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your TipMe withdrawal didn’t go through',
        heading: 'Your withdrawal didn’t go through',
        blocks: [
          {
            kind: 'text',
            text: `Your withdrawal of ${ngn(data.amountMinor)} failed. The money is back in your balance, so you can try again.`,
          },
          {
            kind: 'button',
            label: 'Go to your dashboard',
            href: mailLink(ctx, '/dashboard', 'dashboard'),
          },
        ],
        reason: 'You get this email for each withdrawal from your balance.',
      },
      ctx,
    ),
});

export const tipReversed = defineMailType({
  id: 'tip_reversed',
  category: 'transactional',
  preference: null,
  schema: z.object({}).strict(),
  sample: {},
  render: (_data, ctx) =>
    letter(
      {
        subject: 'A refund or dispute on a TipMe tip',
        heading: 'A tip was refunded or disputed',
        blocks: [
          {
            kind: 'text',
            text: 'The payment provider reported a refund or dispute on a tip you received. Our team is looking at it, and your TipMe balance hasn’t changed. We’ll contact you if we need anything.',
          },
        ],
        reason:
          'You get this email when a tip you received is refunded or disputed.',
      },
      ctx,
    ),
});

export const milestone = defineMailType({
  id: 'milestone',
  category: 'engagement',
  preference: 'notify_milestones',
  schema: z.object({ copy: z.string().min(1).max(200) }).strict(),
  sample: { copy: '10 tips! People keep coming back to thank you.' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'A TipMe milestone',
        heading: 'You reached a milestone',
        blocks: [
          { kind: 'text', text: data.copy },
          {
            kind: 'button',
            label: 'See your tips',
            href: mailLink(ctx, '/dashboard/tips', 'see_tips'),
          },
        ],
        reason: 'You get this email when you reach a milestone on TipMe.',
      },
      ctx,
    ),
});
