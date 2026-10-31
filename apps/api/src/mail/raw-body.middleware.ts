import type { NextFunction, Request, Response } from 'express';

const PREFIX = '/v1/webhooks/mail/';
/** Bounce notices quote the original headers, so this is larger than the API's JSON limit. */
const LIMIT_BYTES = 256 * 1024;

type RawRequest = Request & { rawBody?: Buffer; _body?: boolean };

/**
 * Mail webhook signatures cover the exact bytes received, and providers don't post JSON (SNS
 * sends text/plain, ZeptoMail a form), so the JSON parser would leave these bodies empty. This
 * reads them raw, whatever the content type. Nothing else passes through it.
 */
export function mailWebhookBody(
  request: RawRequest,
  response: Response,
  next: NextFunction,
): void {
  if (request.method !== 'POST' || !request.path.startsWith(PREFIX)) {
    next();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > LIMIT_BYTES) tooLarge = true;
    else chunks.push(chunk);
  });
  request.on('error', next);
  request.on('end', () => {
    if (tooLarge) {
      response.status(413).json({
        error: {
          code: 'INVALID_INPUT',
          message: 'The request is too large.',
          reference: '',
        },
      });
      return;
    }
    request.rawBody = Buffer.concat(chunks);
    // body-parser skips a request already marked as parsed.
    request._body = true;
    request.body = {};
    next();
  });
}
