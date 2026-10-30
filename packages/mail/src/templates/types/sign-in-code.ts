import { z } from 'zod';
import { defineMailType } from '../define.js';
import { letter } from '../layout.js';

const code = z.string().regex(/^\d{6}$/);

/** Each code email: the same layout, what it is for, and how to treat it. */
function codeMail(input: {
  id: string;
  subject: string;
  heading: string;
  intro: string;
  reason: string;
}) {
  return defineMailType({
    id: input.id,
    category: 'security',
    preference: null,
    schema: z.object({ code }).strict(),
    sample: { code: '482915' },
    render: (data, ctx) =>
      letter(
        {
          // The code never goes in the subject, which shows on lock screens and in logs.
          subject: input.subject,
          heading: input.heading,
          blocks: [
            { kind: 'text', text: input.intro },
            { kind: 'code', code: data.code },
            {
              kind: 'text',
              text: 'It expires in 10 minutes. Never share it with anyone. TipMe staff will never ask for it.',
            },
          ],
          reason: input.reason,
        },
        ctx,
      ),
  });
}

export const signInCode = codeMail({
  id: 'sign_in_code',
  subject: 'Your TipMe sign-in code',
  heading: 'Your sign-in code',
  intro: 'Enter this code to sign in to TipMe.',
  reason:
    'You get this email because someone asked to sign in to TipMe with this address. If it wasn’t you, ignore it.',
});

export const emailChangeCode = codeMail({
  id: 'email_change_code',
  subject: 'Confirm your new TipMe email',
  heading: 'Confirm your new email',
  intro: 'Enter this code to make this your TipMe sign-in email.',
  reason:
    'You get this email because someone asked to use this address for a TipMe account. If it wasn’t you, ignore it.',
});
