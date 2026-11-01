import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

/** Carries the one-time enrolment link (30 minutes); the link is its only secret. */
export const staffInvitation = defineMailType({
  id: 'staff_invitation',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z
    .object({
      code: z.string().regex(/^[A-Z2-7]{10}$/),
      kind: z.enum(['invited', 'reset']),
    })
    .strict(),
  sample: { code: 'SAMPLEC2DE', kind: 'invited' },
  render: (data, ctx) => {
    const invited = data.kind === 'invited';
    const title = invited
      ? 'You’ve been added to the TipMe admin area'
      : 'Set up your TipMe admin authenticator again';
    return letter(
      {
        subject: title,
        heading: title,
        blocks: [
          {
            kind: 'text',
            text: invited
              ? 'Sign in with this email address, then set up an authenticator app to finish. This link works once, for 30 minutes.'
              : 'Your authenticator was reset, so your admin access is paused until you set up a new one. This link works once, for 30 minutes.',
          },
          {
            kind: 'button',
            label: 'Set up your authenticator',
            href: mailLink(ctx, `/ops#enrol=${data.code}`, 'staff_enrol', true),
          },
          {
            kind: 'text',
            text: 'If you weren’t expecting this, ignore this email and tell the person who runs your TipMe admin area.',
          },
        ],
        reason: invited
          ? 'You get this email because a TipMe admin added this address as staff.'
          : 'You get this email because a TipMe owner reset your admin authenticator.',
      },
      ctx,
    );
  },
});
