import {
  applyDecorators,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { isIPv4, isIPv6 } from 'node:net';
import { Reflector } from '@nestjs/core';
import type { Logger } from '@tipme/observability';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { REDIS } from '../infra/infra.module.js';
import { LOGGER } from '../tokens.js';

type RateLimitedRoute =
  | 'quotes'
  | 'intents'
  | 'auth_code'
  | 'auth_verify'
  | 'handles'
  | 'analytics'
  | 'reports';

/**
 * Who a request counts against: an IPv4 address (IPv4-mapped IPv6 unwrapped), or an IPv6 /64,
 * since one phone or household rotates through addresses inside a single /64.
 */
export function rateLimitSubject(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped && isIPv4(mapped)) return mapped;
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return 'unknown';
  const [head = '', tail = ''] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = [
    ...headParts,
    ...Array<string>(8 - headParts.length - tailParts.length).fill('0'),
    ...tailParts,
  ];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}
const RATE_LIMIT_ROUTE = 'tipme:rate-limit-route';

export class RateLimitedException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super('RATE_LIMITED', 429);
  }
}

/**
 * Fixed one-minute window per client IP in Redis. Fails open when Redis errors: availability
 * matters more than throttling, and the failure is logged.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = this.reflector.get<RateLimitedRoute | undefined>(
      RATE_LIMIT_ROUTE,
      context.getHandler(),
    );
    if (!route) return true;
    // Sign-in codes are limited per hour; everything else per minute.
    const { limit, windowMs } = {
      quotes: {
        limit: this.config.RATE_LIMIT_QUOTES_PER_MIN,
        windowMs: 60_000,
      },
      intents: {
        limit: this.config.RATE_LIMIT_INTENTS_PER_MIN,
        windowMs: 60_000,
      },
      handles: {
        limit: this.config.RATE_LIMIT_HANDLES_PER_MIN,
        windowMs: 60_000,
      },
      analytics: {
        limit: this.config.RATE_LIMIT_ANALYTICS_PER_MIN,
        windowMs: 60_000,
      },
      // Reporting a page (PR-013): a few an hour from one address is plenty for a real visitor.
      reports: {
        limit: this.config.RATE_LIMIT_REPORTS_PER_HOUR,
        windowMs: 3_600_000,
      },
      auth_code: {
        limit: this.config.RATE_LIMIT_AUTH_PER_HOUR,
        windowMs: 3_600_000,
      },
      // Verifying is limited more loosely: guessing one number is stopped by its own lockout.
      auth_verify: {
        limit: this.config.RATE_LIMIT_AUTH_PER_HOUR * 3,
        windowMs: 3_600_000,
      },
    }[route];
    const ip = rateLimitSubject(
      context.switchToHttp().getRequest<Request>().ip,
    );
    const now = Date.now();
    const key = `rl:${this.config.QUEUE_PREFIX}:${route}:${ip}:${Math.floor(now / windowMs)}`;
    let count: number;
    try {
      const results = await this.redis
        .multi()
        .incr(key)
        .expire(key, windowMs / 1000)
        .exec();
      const [incr] = results ?? [];
      if (!incr || incr[0]) throw new Error('rate limit count failed');
      count = Number(incr[1]);
    } catch {
      this.logger.warn({ event: 'rate_limit.unavailable', route });
      return true;
    }
    if (count > limit)
      throw new RateLimitedException(
        Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000)),
      );
    return true;
  }
}

export const RateLimit = (route: RateLimitedRoute) =>
  applyDecorators(
    SetMetadata(RATE_LIMIT_ROUTE, route),
    UseGuards(RateLimitGuard),
  );
