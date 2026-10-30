import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

/** Retired by email recovery (Part 6). */
export const recoveryLink = defineMailType({
  id: 'recovery_link',
  category: 'security',
  preference: null,
  schema: z.object({ token: z.string().min(16).max(128) }).strict(),
  sample: { token: 'sample-token-sample-token-sample-token-0002' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Get back into TipMe',
        heading: 'Get back into TipMe',
        blocks: [
          {
            kind: 'text',
            text: 'Lost your phone number? Attach a new one with this link. It works for 30 minutes, and you will need a code sent to the new number.',
          },
          {
            kind: 'button',
            label: 'Attach a new number',
            href: mailLink(ctx, `/recover#r=${data.token}`, 'recover', true),
          },
          {
            kind: 'text',
            text: 'If you didn’t ask for this, ignore this email.',
          },
        ],
        reason:
          'You get this email because someone asked to recover this TipMe account.',
      },
      ctx,
    ),
});
