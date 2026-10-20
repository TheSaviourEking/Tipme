import { previewKeyMatches, validPreviewTicket } from '@tipme/domain';
import type { NextFunction, Request, Response } from 'express';
import { readCookie } from '../auth/cookies.js';
import { currentReference } from './reference.js';

export const PREVIEW_COOKIE = '__Secure-tipme_preview';

// Open without the preview cookie: health probes, the release check (its own bearer token) and
// signed provider webhooks. Anything unusual in the path is never treated as open.
const OPEN = [
  /^\/health(\/(live|ready|release))?$/,
  /^\/v1\/release\//,
  /^\/v1\/webhooks\//,
];

/**
 * Staging/preview only (DEPLOYMENT_MODE=preview): deny by default. A request needs the signed
 * preview ticket cookie (browsers) or the server key header (the web server and internal calls).
 */
export function previewGate(password: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const raw = (request.url ?? '/').split('?')[0] ?? '/';
    const plain = !/\/\/|%|\.\./.test(raw);
    if (
      request.method === 'OPTIONS' ||
      (plain && OPEN.some((p) => p.test(raw)))
    ) {
      next();
      return;
    }
    const key = request.headers['x-tipme-preview-key'];
    if (
      validPreviewTicket(readCookie(request, PREVIEW_COOKIE), password) ||
      previewKeyMatches(typeof key === 'string' ? key : undefined, password)
    ) {
      next();
      return;
    }
    response.status(401).json({
      error: {
        code: 'PREVIEW_REQUIRED',
        message:
          'This is a private preview. Please sign in with the preview password.',
        reference: currentReference(),
      },
    });
  };
}
