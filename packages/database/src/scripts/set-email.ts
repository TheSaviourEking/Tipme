import { parseArgs } from 'node:util';
import { setAccountEmail } from '../operations/email-sign-in.js';
import { runAgainstLocalDatabase } from './run.js';

// pnpm ops:set-email --handle <h> --email <e> --reason "<why>": gives an account from before email
// sign-in an address to sign in with. Whoever runs it vouches for the address.
const { values } = parseArgs({
  options: {
    handle: { type: 'string' },
    email: { type: 'string' },
    reason: { type: 'string' },
  },
});
const { handle, email, reason } = values;

if (!handle || !email || !reason || reason.trim().length < 10) {
  console.error(
    'Usage: pnpm ops:set-email --handle <handle> --email <address> --reason "<at least 10 characters>"',
  );
  process.exitCode = 1;
} else {
  await runAgainstLocalDatabase(
    async (db) => {
      const outcome = await setAccountEmail(db, { handle, email, reason });
      console.log(
        {
          set: `@${handle} now signs in with that email.`,
          taken: 'Not changed: that email is verified on another account.',
          not_found: `Not changed: no page @${handle}.`,
          invalid: 'Not changed: that is not a valid email address.',
        }[outcome],
      );
      if (outcome !== 'set') process.exitCode = 1;
    },
    { allowNamedServerDatabase: true },
  );
}
