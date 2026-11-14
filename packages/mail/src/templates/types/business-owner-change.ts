import { z } from 'zod';
import { defineMailType } from '../define.js';
import { letter } from '../layout.js';

const name = z.string().trim().min(1).max(120);

/**
 * Owner-change lock (owner, 14 Nov 2026): every owner of a business hears when its owners change,
 * or when an owner asks to remove another and is refused. Plain, neutral words: an owner removal
 * is checked with both owners first, and nothing here implies a dispute. Names stay in the body.
 */
export const businessOwnerChange = defineMailType({
  id: 'business_owner_change',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z
    .object({
      change: z.enum(['removal_blocked', 'removed_by_tipme', 'stepped_down']),
      businessName: name,
      /** The owner the change is about. */
      ownerName: name,
      /** Who asked, for a refused removal only. */
      actorName: name.optional(),
      /** Which of them the reader is, so the words can say "you". */
      you: z.enum(['actor', 'owner', 'other']),
    })
    .strict()
    .refine((data) => data.change !== 'removal_blocked' || data.actorName, {
      message: 'A refused removal names who asked',
      path: ['actorName'],
    }),
  sample: {
    change: 'removal_blocked',
    businessName: 'The Yellow Chilli',
    ownerName: 'Tobi Adeyemi',
    actorName: 'Ada Okafor',
    you: 'other',
  },
  render: (data, ctx) => {
    const owner = data.you === 'owner' ? 'you' : data.ownerName;
    const lines =
      data.change === 'removal_blocked'
        ? {
            subject: 'Someone asked to remove an owner of your business',
            heading: 'An owner removal was asked for',
            preheader:
              'Nothing changed. TipMe checks any owner removal with both owners first.',
            text: `${data.you === 'actor' ? 'You' : data.actorName} asked to remove ${owner} as an owner of ${data.businessName}. Nothing changed. TipMe checks any owner removal with both owners first.`,
          }
        : data.change === 'removed_by_tipme'
          ? {
              subject: 'The owners of your business changed',
              heading: 'An owner was removed',
              preheader: 'TipMe support made a change to who owns a business.',
              text: `TipMe removed ${owner} as an owner of ${data.businessName}.${data.you === 'owner' ? ' You no longer manage it on TipMe.' : ''}`,
            }
          : {
              subject: 'The owners of your business changed',
              heading: 'An owner stepped down',
              preheader: 'An owner of a business on TipMe stepped down.',
              text: `${data.you === 'owner' ? 'You' : data.ownerName} stepped down as an owner of ${data.businessName}.${data.you === 'owner' ? ' You no longer manage it on TipMe.' : ''}`,
            };
    return letter(
      {
        subject: lines.subject,
        heading: lines.heading,
        preheader: lines.preheader,
        tag: 'safety',
        blocks: [
          { kind: 'text', text: lines.text },
          {
            kind: 'quiet',
            text: 'To change who owns a business, contact support@usetipme.xyz. We check it with both owners first.',
          },
          {
            kind: 'alarm',
            title: 'Didn’t expect this?',
            text: 'Contact support@usetipme.xyz and we’ll look into it.',
          },
        ],
        reason:
          'You get this email when the owners of a business you own, or owned, on TipMe change.',
      },
      ctx,
    );
  },
});
