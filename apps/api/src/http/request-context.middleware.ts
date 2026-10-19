import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '@tipme/observability';
import { currentReference } from './reference.js';

/**
 * Registered on the raw HTTP adapter before the body parser, so every request,
 * including rejected bodies, gets a reference header and exactly one log line.
 */
export function requestContext(logger: Logger) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const reference = currentReference();
    const started = performance.now();
    response.locals['reference'] = reference;
    response.setHeader('X-Request-Id', reference);
    response.once('finish', () => {
      // Allowlist only: never headers, bodies, query strings or raw URLs.
      logger.info({
        event: 'http.request',
        method: request.method,
        route:
          (request.route as { path?: string } | undefined)?.path ?? 'unmatched',
        status: response.statusCode,
        duration_ms: Math.round(performance.now() - started),
        reference,
      });
    });
    next();
  };
}
