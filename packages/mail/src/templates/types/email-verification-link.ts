import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

/** Retired by email sign-in (Part 5). */
export const emailVerificationLink = defineMailType({
  id: 'email_verification_link',
  category: 'security',
  sender: 'security',
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
            text: 'Confirm this address for your TipMe account, so we can reach you about your tips and your money.',
          },
          { kind: 'button', label: 'Confirm my email', href: link },
          {
            kind: 'quiet',
            text: 'The link works for 24 hours. If you didn’t ask for this, ignore this email.',
          },
        ],
        reason:
          'You get this email because this address was added to a TipMe account.',
      },
      ctx,
    );
  },
});
