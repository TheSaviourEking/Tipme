import {
  rawBodyUnder,
  type RawBodyMiddleware,
} from '../http/raw-body.middleware.js';

/**
 * CI's changelog requests are verified over their exact bytes before parsing. A draft carries a
 * PR body of up to 64 Ki characters, above the API's 16 KB JSON limit, so these are read raw up
 * to 128 KiB (changelog plan, Design §3).
 */
export const changelogWebhookBody: RawBodyMiddleware = rawBodyUnder(
  '/v1/webhooks/changelog/',
  128 * 1024,
);
