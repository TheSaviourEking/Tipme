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
      /** A business's own bank (R2-B), told to each of its owners. */
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
        // The first text names someone or something private; the preview line must not.
        preheader:
          'A withdrawal already under way still goes to the account it started with.',
        blocks: [
          {
            kind: 'text',
            text: `${data.businessName ? `${data.businessName}’s` : 'Your'} next TipMe withdrawal will go to ${data.bankName} ••${data.last4}, not ${data.previousBankName} ••${data.previousLast4}. A withdrawal already under way still goes to the account it started with.`,
          },
          {
            kind: 'text',
            text: 'If this wasn’t you, contact support@usetipme.xyz straight away.',
          },
        ],
        reason: data.businessName
          ? 'You get this email because the bank account of a business you own on TipMe was changed.'
          : 'You get this email because the bank account on your TipMe account was changed.',
      },
      ctx,
    ),
});
