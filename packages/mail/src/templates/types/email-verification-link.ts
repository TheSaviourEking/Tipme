import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

/** Retired by email sign-in (Part 5). */
export const emailVerificationLink = defineMailType({
  id: 'email_verification_link',
  category: 'security',
  preference: null,
  schema: z.object({ token: z.string().min(16).max(128) }).strict(),
  sample: { token: 'sample-token-sample-token-sample-token-0001' },
  render: (data, ctx) => {
    const link = mailLink(ctx, `/verify-email#v=${data.token}`, 'verify', true);
    return letter(
      {
        subject: 'Confirm your email for TipMe',
        heading: 'Confirm your email',
        blocks: [
          {
            kind: 'text',
            text: 'Confirm this address for your TipMe account. The link works for 24 hours.',
          },
          { kind: 'button', label: 'Confirm my email', href: link },
          {
            kind: 'text',
            text: 'If you didn’t ask for this, ignore this email.',
          },
        ],
        reason:
          'You get this email because someone added this address to a TipMe account.',
      },
      ctx,
    );
  },
});
