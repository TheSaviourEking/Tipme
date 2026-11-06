import type { NextFunction, Request, Response } from 'express';

type RawRequest = Request & { rawBody?: Buffer; _body?: boolean };
export type RawBodyMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
) => void;

/**
 * Reads POST bodies under `prefix` raw, whatever the content type, up to `limitBytes` (413 past
 * it, before anything parses them). For signed webhooks: the signature covers the exact bytes,
 * and the route verifies it before parsing. Nothing else passes through it.
 */
export function rawBodyUnder(
  prefix: string,
  limitBytes: number,
): RawBodyMiddleware {
  return (incoming, response, next) => {
    const request = incoming as RawRequest;
    if (request.method !== 'POST' || !request.path.startsWith(prefix)) {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) tooLarge = true;
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
  };
}
