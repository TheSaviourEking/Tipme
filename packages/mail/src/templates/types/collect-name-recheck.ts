import { z } from 'zod';
import { defineMailType, mailLink } from '../define.js';
import { letter } from '../layout.js';

/**
 * You collect (Task 15 fix round 1, I3): support changed the recipient's verified name, so our
 * payment partner checks it again with their bank details before more tips move to them. Sent once
 * per change. It names no bank, number, name or partner.
 */
export const collectNameRecheck = defineMailType({
  id: 'collect_name_recheck',
  category: 'account',
  sender: 'notifications',
  preference: null,
  schema: z.object({ firstName: z.string().min(1).max(80) }).strict(),
  sample: { firstName: 'Ada' },
  render: (data, ctx) =>
    letter(
      {
        subject: 'Add your bank details again',
        heading: `${data.firstName}, add your bank details again`,
        preheader: 'So we can check your new name and send your tips.',
        blocks: [
          {
            kind: 'text',
            text: 'Your verified name was changed. Add your bank details again so our payment partner can check the new name and send your tips. Your tips are kept for you until then.',
          },
          {
            kind: 'button',
            label: 'Add your bank details',
            href: mailLink(ctx, '/dashboard', 'collect_name_recheck'),
          },
          {
            kind: 'quiet',
            text: 'If you didn’t ask for your name to be changed, contact support@usetipme.xyz now.',
          },
        ],
        reason:
          'You get this email when the verified name on your TipMe account is changed.',
      },
      ctx,
    ),
});
