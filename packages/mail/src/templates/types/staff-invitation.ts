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
            text: invited
              ? 'Don’t want this? Open the link, sign in, and choose Decline. If you weren’t expecting it at all, tell the person who runs your TipMe admin area.'
              : 'If you weren’t expecting this, tell the person who runs your TipMe admin area.',
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

/**
 * To whoever invited them and to owners: a masked address, enough to recognise. Also to the person,
 * in their own words (`own`), so a decline from a stolen session is not silent.
 */
export const staffInvitationDeclined = defineMailType({
  id: 'staff_invitation_declined',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z
    .object({
      personHint: z.string().max(260),
      roleName: z.string().max(100),
      own: z.literal(true).optional(),
    })
    .strict(),
  sample: { personHint: 'a•••@example.com', roleName: 'Support' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'A TipMe admin invitation was declined',
        heading: 'Invitation declined',
        blocks: [
          {
            kind: 'text',
            text: data.own
              ? `You declined your invitation to the admin area (role: ${data.roleName}). You have no admin access. If this wasn’t you, someone else may be signed in to your account: tell whoever invited you.`
              : `${data.personHint} declined their invitation to the admin area (role: ${data.roleName}). They have no admin access, and they can be invited again.`,
          },
        ],
        reason: data.own
          ? 'You get this email because a TipMe admin invitation to this address was declined.'
          : 'You get this email because you invited this person or you are a TipMe owner.',
      },
      ctx,
    ),
});
