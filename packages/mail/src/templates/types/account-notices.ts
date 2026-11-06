import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { lagosMinute } from '../dates.js';
import { letter } from '../layout.js';

export const welcome = defineMailType({
  id: 'welcome',
  category: 'account',
  sender: 'hello',
  preference: null,
  schema: z.object({}).strict(),
  sample: {},
  render: (_data, ctx) =>
    letter(
      {
        subject: 'Welcome to TipMe',
        heading: 'Welcome to TipMe',
        blocks: [
          {
            kind: 'text',
            text: 'One link people can use to thank you with a tip. Three steps and you are ready:',
          },
          {
            kind: 'steps',
            items: [
              'Claim your username and add your face.',
              'Add the bank account your money goes to.',
              'Share your link or your QR code.',
            ],
          },
          {
            kind: 'button',
            label: 'Create your page',
            href: mailLink(ctx, '/sign-up', 'create_page'),
          },
        ],
        reason: 'You get this email because you just created a TipMe account.',
      },
      ctx,
    ),
});

export const newSignInNotice = defineMailType({
  id: 'new_sign_in_notice',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z
    .object({
      deviceLabel: z.string().max(80),
      /** When it happened. Optional: mail queued before it existed has none. */
      at: z.iso.datetime().optional(),
    })
    .strict(),
  sample: { deviceLabel: 'Safari on iPhone', at: '2026-11-05T13:32:00.000Z' },
  render: (data, ctx) => {
    const rows = [
      ...(data.deviceLabel
        ? [{ label: 'Device', value: data.deviceLabel }]
        : []),
      ...(data.at ? [{ label: 'When', value: lagosMinute(data.at) }] : []),
    ];
    return letter(
      {
        subject: 'New sign-in to your TipMe account',
        heading: 'A new device signed in',
        tag: 'safety',
        // The device is private; the preview line must not name it.
        preheader: 'If this was you, there’s nothing to do.',
        blocks: [
          {
            kind: 'text',
            text: 'Your TipMe account was just signed in to from a device we haven’t seen before.',
          },
          ...(rows.length ? [{ kind: 'facts' as const, rows }] : []),
          { kind: 'quiet', text: 'If this was you, there’s nothing to do.' },
          // The board leaves this out; it is the only instruction for the case that matters.
          {
            kind: 'alarm',
            title: 'Wasn’t you?',
            text: 'Sign in and end that session in Settings.',
          },
          {
            kind: 'button',
            label: 'Check your sign-ins',
            href: mailLink(ctx, '/dashboard/settings#security', 'sessions'),
          },
        ],
        reason: 'You get this email to help keep your account safe.',
      },
      ctx,
    );
  },
});

export const emailChangedNotice = defineMailType({
  id: 'email_changed_notice',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z.object({ newEmailHint: z.string().max(260) }).strict(),
  sample: { newEmailHint: 'a•••@example.com' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your TipMe sign-in email changed',
        heading: 'Your sign-in email changed',
        tag: 'safety',
        // The first text names someone or something private; the preview line must not.
        preheader: 'Your sign-in email changed.',
        blocks: [
          {
            kind: 'text',
            text: `Your TipMe account now signs in with ${data.newEmailHint}. This address no longer works for it.`,
          },
          {
            kind: 'alarm',
            title: 'Wasn’t you?',
            text: 'If this wasn’t you, contact support@usetipme.xyz straight away.',
          },
        ],
        reason:
          'You get this email because this was the sign-in address of a TipMe account.',
      },
      ctx,
    ),
});

export const recoveryStartedNotice = defineMailType({
  id: 'recovery_started_notice',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z.object({ newEmailHint: z.string().max(260) }).strict(),
  sample: { newEmailHint: 'a•••@example.com' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your TipMe account is being moved to a new email',
        heading: 'Someone is moving your account',
        tag: 'safety',
        // The first text names someone or something private; the preview line must not.
        preheader:
          'It happens in 24 hours. If this wasn’t you, sign in now and cancel it in Settings.',
        blocks: [
          {
            kind: 'text',
            text: `A recovery was started to move your TipMe account to ${data.newEmailHint}. It happens in 24 hours.`,
          },
          {
            kind: 'alarm',
            title: 'Wasn’t you?',
            text: 'If this wasn’t you, sign in now and cancel it in Settings.',
          },
          {
            kind: 'button',
            label: 'Sign in and cancel',
            href: mailLink(ctx, '/dashboard/settings', 'cancel_recovery'),
          },
        ],
        reason: 'You get this email to help keep your account safe.',
      },
      ctx,
    ),
});

export const recoveryCompletedNotice = defineMailType({
  id: 'recovery_completed_notice',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z.object({ newEmailHint: z.string().max(260) }).strict(),
  sample: { newEmailHint: 'a•••@example.com' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your TipMe account moved to a new email',
        heading: 'Your account moved',
        tag: 'safety',
        // The first text names someone or something private; the preview line must not.
        preheader: 'Every device was signed out.',
        blocks: [
          {
            kind: 'text',
            text: `Your TipMe account now signs in with ${data.newEmailHint}. Every device was signed out.`,
          },
          {
            kind: 'alarm',
            title: 'Wasn’t you?',
            text: 'If this wasn’t you, contact support@usetipme.xyz straight away.',
          },
        ],
        reason:
          'You get this email because a recovery of this TipMe account just finished.',
      },
      ctx,
    ),
});

/** Staying vague about why: this can reach an address that isn't the account's owner. */
export const recoveryCancelledNotice = defineMailType({
  id: 'recovery_cancelled_notice',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z.object({ newEmailHint: z.string().max(260).nullable() }).strict(),
  sample: { newEmailHint: 'a•••@example.com' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your TipMe account recovery was cancelled',
        heading: 'Recovery cancelled',
        // The first text names someone or something private; the preview line must not.
        preheader: 'Its sign-in details stay as they were.',
        blocks: [
          {
            kind: 'text',
            text: data.newEmailHint
              ? `A request to move this TipMe account to ${data.newEmailHint} was cancelled, because the account’s access changed. Its sign-in details stay as they were.`
              : 'A request to recover this TipMe account was cancelled, because the account’s access changed. Its sign-in details stay as they were.',
          },
          {
            kind: 'text',
            text: 'If you still need to recover it, contact support@usetipme.xyz.',
          },
        ],
        reason:
          'You get this email because a recovery of this TipMe account was waiting.',
      },
      ctx,
    ),
});
