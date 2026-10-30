import { ZodError } from 'zod';
import type { MailContext, MailType, RenderedMail } from './define.js';
import { emailVerificationLink } from './types/email-verification-link.js';
import { phoneChangeWarning } from './types/phone-change-warning.js';
import { providerTest } from './types/provider-test.js';
import { recoveryLink } from './types/recovery-link.js';
import { tipReceived } from './types/tip-received.js';
import { weeklyReport } from './types/weekly-report.js';

// Heterogeneous registry: each entry checks its own data with its schema before rendering.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MAIL_TYPES: Record<string, MailType<any>> = Object.fromEntries(
  [
    tipReceived,
    weeklyReport,
    emailVerificationLink,
    recoveryLink,
    phoneChangeWarning,
    providerTest,
  ].map((type) => [type.id, type]),
);

/** Validates, renders, and makes the stored snapshot (none for security mail). */
export function renderMail(
  typeId: string,
  data: unknown,
  ctx: MailContext,
): RenderedMail & { snapshot: RenderedMail | null } {
  const type = MAIL_TYPES[typeId];
  if (!type)
    throw new ZodError([
      {
        code: 'custom',
        message: `Unknown mail type ${typeId}`,
        path: ['type'],
        input: typeId,
      },
    ]);
  const parsed: unknown = type.schema.parse(data);
  const rendered = type.render(parsed, { ...ctx, redact: false });
  const snapshot =
    type.category === 'security'
      ? null
      : type.render(parsed, { ...ctx, redact: true });
  return { ...rendered, snapshot };
}
