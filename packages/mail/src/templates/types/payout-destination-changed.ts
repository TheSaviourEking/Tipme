import { z } from 'zod';
import { defineMailType } from '../define.js';
import { letter } from '../layout.js';

const bankName = z.string().min(1).max(120);
const last4 = z.string().regex(/^\d{4}$/);

/** Told every time the account withdrawals go to is replaced: the bank's name and last four only. */
export const payoutDestinationChanged = defineMailType({
  id: 'payout_destination_changed',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z
    .object({
      bankName,
      last4,
      previousBankName: bankName,
      previousLast4: last4,
      /** A business's own bank (R2-B), told to each of its owners. In the body only. */
      businessName: z.string().min(1).max(80).optional(),
    })
    .strict(),
  sample: {
    bankName: 'Guaranty Trust Bank',
    last4: '1234',
    previousBankName: 'Providus Bank',
    previousLast4: '6789',
  },
  render: (data, ctx) =>
    letter(
      {
        subject: data.businessName
          ? 'Your business’s TipMe bank account changed'
          : 'Your TipMe bank account changed',
        heading: data.businessName
          ? 'The business’s bank account changed'
          : 'Your bank account changed',
        tag: 'safety',
        blocks: [
          {
            kind: 'text',
            // The first text is the preview line: the business's name stays in the facts below.
            text: data.businessName
              ? 'The business’s next withdrawal goes to the new account. One already under way still goes to the account it started with.'
              : 'Your next withdrawal goes to the new account. One already under way still goes to the account it started with.',
          },
          {
            kind: 'facts',
            rows: [
              ...(data.businessName
                ? [{ label: 'Business', value: data.businessName }]
                : []),
              { label: 'Now', value: `${data.bankName} ••${data.last4}` },
              {
                label: 'Before',
                value: `${data.previousBankName} ••${data.previousLast4}`,
                before: true,
              },
            ],
          },
          {
            kind: 'alarm',
            title: 'Wasn’t you?',
            text: 'Contact support@usetipme.xyz straight away. We can stop withdrawals while we look.',
          },
        ],
        reason: data.businessName
          ? 'You get this email whenever the bank account of a business you own on TipMe changes.'
          : 'You get this email whenever the bank account on your TipMe page changes.',
      },
      ctx,
    ),
});
