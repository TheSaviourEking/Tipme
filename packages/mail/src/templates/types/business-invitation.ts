import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

/**
 * A business invites someone to its team, or to help manage it (business PR B3). The one-time code
 * travels only in the link's fragment (`/dashboard/work#join=`), so it never reaches a server log;
 * the link is untracked, so no redirect carries it either, and the stored snapshot redacts it.
 */
export const businessInvitation = defineMailType({
  id: 'business_invitation',
  category: 'account',
  sender: 'notifications',
  preference: null,
  tracking: false,
  schema: z
    .object({
      code: z.string().regex(/^[A-Z2-7]{16}$/),
      businessName: z.string().min(1).max(80),
      locationName: z.string().min(1).max(60).optional(),
      kind: z.enum(['staff', 'manager']),
      role: z.enum(['owner', 'location_manager']).optional(),
    })
    .strict(),
  sample: {
    code: 'SAMPLEC2DEFGHJKM',
    businessName: 'The Yellow Chilli',
    locationName: 'Victoria Island',
    kind: 'staff' as const,
  },
  render: (data, ctx) => {
    const staff = data.kind === 'staff';
    const where = data.locationName
      ? `${data.businessName} · ${data.locationName}`
      : data.businessName;
    const subject = staff
      ? `${data.businessName} invites you to receive tips there`
      : `${data.businessName} invites you to help manage it on TipMe`;
    return letter(
      {
        subject,
        heading: staff
          ? 'You’re invited to the team'
          : 'You’re invited to help manage a business',
        blocks: [
          {
            kind: 'text',
            text: staff
              ? `${where} would like to list you on its TipMe page, so customers can find you and tip you there. Your tips go to your own TipMe balance, as always.`
              : data.role === 'owner'
                ? `${where} would like you to be an owner on TipMe: you would manage its locations, team and codes. Your own tips go to your own TipMe balance, as always.`
                : `${where} would like you to manage this location on TipMe: its team and codes. Your own tips go to your own TipMe balance, as always.`,
          },
          {
            kind: 'button',
            label: 'See the invitation',
            href: mailLink(
              ctx,
              `/dashboard/work#join=${data.code}`,
              'business_invitation',
              true,
            ),
          },
          {
            kind: 'text',
            text: 'This link works once, for 7 days. Sign in with this email address to accept or decline. If you weren’t expecting it, you can ignore this email.',
          },
        ],
        reason:
          'You get this email because a business on TipMe invited this address.',
      },
      ctx,
    );
  },
});
