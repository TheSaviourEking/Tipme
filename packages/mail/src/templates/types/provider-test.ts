import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

/** Staff test of a mail provider before it can become active (spec §5). */
export const providerTest = defineMailType({
  id: 'provider_test',
  category: 'account',
  sender: 'system',
  preference: null,
  tracking: false,
  schema: z
    .object({
      providerLabel: z.string().min(1).max(40),
      token: z.string().min(16).max(128),
    })
    .strict(),
  sample: {
    providerLabel: 'ZeptoMail',
    token: 'sample-token-sample-token-sample-token-0003',
  },
  render: (data, ctx) =>
    letter(
      {
        subject: `TipMe mail test: ${data.providerLabel}`,
        heading: `This email came through ${data.providerLabel}`,
        blocks: [
          {
            kind: 'text',
            text: 'Open the link while signed in to TipMe ops to confirm the provider delivers mail.',
          },
          {
            kind: 'button',
            label: 'Confirm this test',
            href: mailLink(
              ctx,
              `/ops/providers/confirm#t=${data.token}`,
              'confirm_test',
              true,
            ),
          },
        ],
        reason: 'A TipMe staff member sent this test from the Providers page.',
      },
      ctx,
    ),
});
