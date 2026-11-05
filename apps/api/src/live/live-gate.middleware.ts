import { LIVE_PATHS } from '@tipme/observability';
import type { NextFunction, Request, Response } from 'express';
import type { LiveMetrics } from './live-metrics.js';

/**
 * In front of the stream routes, before any guard. With live updates off they answer 204 at once,
 * exactly as before the feature: nothing counts against a rate limit and nothing touches Redis or
 * Postgres. With them on, it counts the refusals the route never sees: a 401 from the session guard
 * and a 429 from the address limit. The route marks `res.locals.liveCounted` for those it counted.
 */
export function liveGate(o: {
  enabled: boolean;
  metrics: Pick<LiveMetrics, 'connect'>;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' || !LIVE_PATHS.has(req.path)) return next();
    if (!o.enabled) {
      o.metrics.connect('disabled');
      res.status(204).end();
      return;
    }
    res.once('finish', () => {
      if (res.locals['liveCounted']) return;
      if (res.statusCode === 401) o.metrics.connect('unauthenticated');
      else if (res.statusCode === 429) o.metrics.connect('rate_limited');
    });
    next();
  };
}
