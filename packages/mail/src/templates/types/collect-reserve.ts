import { z } from 'zod';
import { defineMailType } from '../define.js';
import { letter } from '../layout.js';

/**
 * You collect (plan Task 11, spec §6.3): to every owner, when TipMe's own money in its partner balance
 * falls below the critical level, a balance goes negative, or the reserve rule breaks (less there
 * than TipMe holds for recipients). Staff are paged at the same time; the words are the staff
 * alert's, which name only currencies, amounts and the partner adapter (staff mail may name it).
 */
export const collectReserveAlert = defineMailType({
  id: 'collect_reserve_alert',
  category: 'security',
  sender: 'security',
  preference: null,
  schema: z.object({ alert: z.string().min(1).max(600) }).strict(),
  sample: {
    alert:
      "You collect reserve critical: TipMe's NGN balance at our payment partner: ₦2,400,000 available, ₦2,200,000 held for recipients, ₦200,000 TipMe's own, below the ₦250,000 critical level.",
  },
  render: (data, ctx) =>
    letter(
      {
        subject: "TipMe's own money at our payment partner is critically low",
        heading: 'Top up TipMe’s balance',
        // The first text has amounts; the preview line must not.
        preheader:
          'Money TipMe holds for recipients must stay covered. Staff have been paged.',
        blocks: [
          { kind: 'text', text: data.alert },
          {
            kind: 'alarm',
            title: 'What to do',
            text: 'Top up TipMe’s balance at our payment partner, and check the issues inbox. Staff have been paged too.',
          },
        ],
        reason: 'You get this email because you are a TipMe owner.',
      },
      ctx,
    ),
});
