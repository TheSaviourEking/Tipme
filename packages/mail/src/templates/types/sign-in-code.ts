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

export const recoveryEmailCode = codeMail({
  id: 'recovery_email_code',
  subject: 'Confirm your TipMe recovery email',
  heading: 'Confirm your recovery email',
  intro:
    'Enter this code to use this address to get back into TipMe if you lose your sign-in email.',
  reason:
    'You get this email because someone added this address as a TipMe recovery email. If it wasn’t you, ignore it.',
});

export const recoveryChangeCode = codeMail({
  id: 'recovery_change_code',
  subject: 'Confirm a change to your TipMe recovery email',
  heading: 'Confirm this change',
  intro: 'Enter this code to change or remove your recovery email.',
  reason:
    'You get this email because someone is changing the recovery email of your TipMe account. If it wasn’t you, sign in and end your other sessions in Settings.',
});

export const recoveryCode = codeMail({
  id: 'recovery_code',
  subject: 'Your TipMe recovery code',
  heading: 'Get back into TipMe',
  intro: 'Enter this code to move your TipMe account to a new sign-in email.',
  reason:
    'You get this email because this is the recovery email of a TipMe account and someone asked to recover it. If it wasn’t you, ignore it.',
});

export const recoveryNewEmailCode = codeMail({
  id: 'recovery_new_email_code',
  subject: 'Confirm your new TipMe sign-in email',
  heading: 'Confirm your new sign-in email',
  intro: 'Enter this code to move a TipMe account to this address.',
  reason:
    'You get this email because someone asked to move a TipMe account to this address. If it wasn’t you, ignore it.',
});
