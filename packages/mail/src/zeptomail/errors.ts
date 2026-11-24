import { MailRejectedError, MailTemporaryError } from '../errors.js';

// Sub-codes ZeptoMail documents as passing conditions: credits, daily or trial limits.
// Everything else it reports is a definite refusal (bad sender, key, address or account).
const TEMPORARY_CODES = new Set(['LE_101', 'LE_102', 'SMI_115', 'SM_133']);
// Refusals about ZeptoMail itself, not the mail (documented, read 23 Nov 2026): SERR_157 invalid
// API key, SERR_156 sending IP not allowed, AE_101 account blocked, SM_128 account not yet
// reviewed, SM_111 sender domain not verified. Another provider can send the same mail.
const PROVIDER_CODES = new Set([
  'SERR_157',
  'SERR_156',
  'AE_101',
  'SM_128',
  'SM_111',
]);

/** The most specific code in a ZeptoMail error body: a detail's sub-code, else the top code. */
export function zeptoErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const { code, details } = error as { code?: unknown; details?: unknown };
  if (Array.isArray(details))
    for (const detail of details)
      if (
        detail &&
        typeof detail === 'object' &&
        typeof (detail as { code?: unknown }).code === 'string'
      )
        return (detail as { code: string }).code;
  return typeof code === 'string' ? code : null;
}

export function zeptoError(
  status: number,
  body: unknown,
): MailRejectedError | MailTemporaryError {
  const code = zeptoErrorCode(body) ?? `http_${status}`;
  if (status === 429 || status >= 500 || TEMPORARY_CODES.has(code))
    return new MailTemporaryError(code);
  return new MailRejectedError(code, {
    providerFault: status === 401 || status === 403 || PROVIDER_CODES.has(code),
  });
}
