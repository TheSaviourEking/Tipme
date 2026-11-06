import {
  rawBodyUnder,
  type RawBodyMiddleware,
} from '../http/raw-body.middleware.js';

/**
 * Mail webhook signatures cover the exact bytes received, and providers don't post JSON (SNS
 * sends text/plain, ZeptoMail a form), so the JSON parser would leave these bodies empty. This
 * reads them raw, whatever the content type. Bounce notices quote the original headers, so the
 * limit is larger than the API's JSON limit.
 */
export const mailWebhookBody: RawBodyMiddleware = rawBodyUnder(
  '/v1/webhooks/mail/',
  256 * 1024,
);
