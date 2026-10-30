import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

export const welcome = defineMailType({
  id: 'welcome',
  category: 'account',
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
            text: 'TipMe gives you one simple link people can use to appreciate you with a tip. Next, create your page and choose your handle.',
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
  preference: null,
  schema: z.object({ deviceLabel: z.string().max(80) }).strict(),
  sample: { deviceLabel: 'Safari on iPhone' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'New sign-in to your TipMe account',
        heading: 'A new device signed in',
        blocks: [
          {
            kind: 'text',
            text: `Your TipMe account was just signed in to from a device we haven’t seen before${data.deviceLabel ? `: ${data.deviceLabel}` : ''}.`,
          },
          {
            kind: 'text',
            text: 'If this was you, there’s nothing to do. If it wasn’t, sign in and end that session in Settings.',
          },
        ],
        reason: 'You get this email to help keep your account safe.',
      },
      ctx,
    ),
});

export const emailChangedNotice = defineMailType({
  id: 'email_changed_notice',
  category: 'security',
  preference: null,
  schema: z.object({ newEmailHint: z.string().max(260) }).strict(),
  sample: { newEmailHint: 'a•••@example.com' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Your TipMe sign-in email changed',
        heading: 'Your sign-in email changed',
        blocks: [
          {
            kind: 'text',
            text: `Your TipMe account now signs in with ${data.newEmailHint}. This address no longer works for it.`,
          },
          {
            kind: 'text',
            text: 'If this wasn’t you, contact support@usetipme.xyz straight away.',
          },
        ],
        reason:
          'You get this email because this was the sign-in address of a TipMe account.',
      },
      ctx,
    ),
});
