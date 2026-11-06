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
        subject: 'Your TipMe bank account changed',
        heading: 'Your bank account changed',
        tag: 'safety',
        blocks: [
          {
            kind: 'text',
            text: 'Your next withdrawal goes to the new account. One already under way still goes to the account it started with.',
          },
          {
            kind: 'facts',
            rows: [
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
        reason:
          'You get this email whenever the bank account on your TipMe page changes.',
      },
      ctx,
    ),
});
