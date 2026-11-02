import { parseArgs } from 'node:util';
import { setAccountEmail } from '../operations/email-sign-in.js';
import { mailSealing } from '../operations/mail-queue.js';
import { runAgainstLocalDatabase } from './run.js';

// pnpm ops:set-email (--handle <h> | --email-current <e>) --email <e> --reason "<why>": gives an
// account an address to sign in with. Whoever runs it vouches for the address. This is also the one
// route that moves a staff member's address; staff accounts usually have no page, so name them by
// their current address. It is logged, and the old address is told if MAIL_SEAL_KEY is set.
const { values } = parseArgs({
  options: {
    handle: { type: 'string' },
    'email-current': { type: 'string' },
    email: { type: 'string' },
    reason: { type: 'string' },
  },
});
const { handle, 'email-current': currentEmail, email, reason } = values;

if (
  Boolean(handle) === Boolean(currentEmail) ||
  !email ||
  !reason ||
  reason.trim().length < 10
) {
  console.error(
    'Usage: pnpm ops:set-email (--handle <handle> | --email-current <address>) --email <address> --reason "<at least 10 characters>"',
  );
  process.exitCode = 1;
} else {
  await runAgainstLocalDatabase(
    async (db) => {
      const sealKey = process.env['MAIL_SEAL_KEY'];
      const outcome = await setAccountEmail(db, {
        ...(handle ? { handle } : { currentEmail: currentEmail! }),
        email,
        reason,
        ...(sealKey
          ? { sealing: mailSealing(Buffer.from(sealKey, 'base64')) }
          : {}),
      });
      const account = handle ? `@${handle}` : 'That account';
      console.log(
        {
          set: `${account} now signs in with that email.`,
          taken: 'Not changed: that email is verified on another account.',
          not_found: handle
            ? `Not changed: no page @${handle}.`
            : 'Not changed: no account has that verified email.',
          invalid: 'Not changed: that is not a valid email address.',
          needs_mail_key:
            'Not changed: this is a staff account, so the old address must be told. Set MAIL_SEAL_KEY and run this again.',
          staff_mailbox_taken:
            'Not changed: that mailbox belongs to another active staff member (dots and +tags count as the same address).',
          bad_reason:
            'Not changed: the reason can’t contain "[change:", which the log keeps for its own record.',
        }[outcome],
      );
      if (outcome === 'set' && !sealKey)
        console.log(
          'MAIL_SEAL_KEY is not set, so the old address was not told. The log records that.',
        );
      if (outcome !== 'set') process.exitCode = 1;
    },
    { allowNamedServerDatabase: true },
  );
}
