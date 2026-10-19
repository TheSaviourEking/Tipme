import { parseArgs } from 'node:util';
import { grantOwner } from '../operations/staff.js';
import { phoneHint } from '../operations/phone.js';
import { runAgainstLocalDatabase } from './run.js';

// pnpm ops:grant-owner --phone <number>: the only way to make someone staff (ADR-0010).
// Prints a one-time enrolment code for registering an authenticator in /ops (30 minutes).
const { values } = parseArgs({ options: { phone: { type: 'string' } } });

if (!values.phone) {
  console.error('Usage: pnpm ops:grant-owner --phone <number>');
  process.exitCode = 1;
} else {
  const phone = values.phone;
  await runAgainstLocalDatabase(async (db) => {
    const { enrolmentCode } = await grantOwner(db, { phone });
    console.log(
      `Owner granted to the account on ${phoneHint(phone.replace(/\D/g, ''))}.`,
    );
    console.log(`One-time enrolment code (30 minutes): ${enrolmentCode}`);
    console.log(
      'Sign in at /ops with that number, then enter the code to set up your authenticator.',
    );
  });
}
