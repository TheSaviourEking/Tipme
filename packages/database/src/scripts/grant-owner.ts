import { parseArgs } from 'node:util';
import { maskEmail } from '../operations/email-address.js';
import { grantOwner } from '../operations/staff.js';
import { phoneHint } from '../operations/phone.js';
import { runAgainstLocalDatabase } from './run.js';

// pnpm ops:grant-owner --email <address>: the only way to make someone staff (ADR-0010).
// Prints a one-time enrolment code for registering an authenticator in /ops (30 minutes).
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    phone: { type: 'string' },
    role: { type: 'string' },
  },
});
const role = values.role ?? 'owner';

if (
  (!values.email && !values.phone) ||
  (role !== 'owner' && role !== 'release_check')
) {
  console.error(
    'Usage: pnpm ops:grant-owner --email <address> [--role owner|release_check]',
  );
  process.exitCode = 1;
} else {
  const { email, phone } = values;
  await runAgainstLocalDatabase(
    async (db) => {
      const { enrolmentCode } = await grantOwner(db, {
        ...(email ? { email } : { phone: phone! }),
        role,
      });
      console.log(
        `Owner granted to the account on ${email ? maskEmail(email) : phoneHint(phone!.replace(/\D/g, ''))}.`,
      );
      console.log(`One-time enrolment code (30 minutes): ${enrolmentCode}`);
      console.log(
        'Sign in at /ops with it, then enter the code to set up your authenticator.',
      );
      // Only this command may run against a server database, and only when it is named on purpose.
    },
    { allowNamedServerDatabase: true },
  );
}
