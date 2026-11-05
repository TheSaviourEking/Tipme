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
import { CodedHttpException } from '../http/coded.exception.js';
import { REDIS } from '../infra/infra.module.js';
import { LOGGER } from '../tokens.js';

type RateLimitedRoute =
  | 'quotes'
  | 'intents'
  | 'auth_code'
  | 'auth_verify'
  | 'handles'
  | 'analytics'
  | 'reports'
  | 'unsubscribe'
  | 'avatars'
  | 'ops_code'
  | 'ops_request'
  | 'cover_designs'
  | 'qr_art'
  | 'qr_thumb'
  | 'bank_resolve'
  | 'bank_read'
  | 'live_connect'
  | 'live_connect_user';

// Looking up a bank account reveals a stranger's name, so one person gets few, on any address.
const BANK_RESOLVES_PER_USER_PER_DAY = 10;
const DAY_MS = 86_400_000;
// Live stream connects per signed-in person per minute: a tab reconnecting with backoff uses few.
const LIVE_CONNECTS_PER_USER_PER_MIN = 30;

type LimitedRequest = Request & { auth?: { userId: string } };

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
export const RATE_LIMIT_ROUTE = 'tipme:rate-limit-route';

export class RateLimitedException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super('RATE_LIMITED', 429);
  }
}

/**
 * Fixed window per client IP in Redis (per signed-in person for bank routes). Fails open when Redis
 * errors, because availability matters more than throttling, and the failure is logged. The one
 * exception is bank_resolve: an unmetered lookup can map strangers' accounts to names, so it stops.
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
    const request = context.switchToHttp().getRequest<LimitedRequest>();
    const ip = rateLimitSubject(request.ip);
    const userId = request.auth?.userId ?? 'anonymous';
    if (route === 'bank_read')
      return this.count(route, `user:${userId}`, {
        limit: this.config.RATE_LIMIT_BANK_READ_PER_MIN,
        windowMs: 60_000,
      });
    if (route === 'live_connect_user')
      return this.count(route, `user:${userId}`, {
        limit: LIVE_CONNECTS_PER_USER_PER_MIN,
        windowMs: 60_000,
      });
    if (route === 'bank_resolve') {
      await this.count(route, ip, {
        limit: this.config.RATE_LIMIT_BANK_RESOLVE_PER_HOUR,
        windowMs: 3_600_000,
      });
      return this.count(route, `user:${userId}`, {
        limit: BANK_RESOLVES_PER_USER_PER_DAY,
        windowMs: DAY_MS,
      });
    }
    // Sign-in codes are limited per hour; everything else per minute.
    const window = {
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
      // Live stream connects, per address and before the session check, so unauthenticated
      // connects count too. The per-person limit is consumeForPerson('live_connect_user').
      live_connect: {
        limit: this.config.RATE_LIMIT_LIVE_CONNECT_PER_MIN,
        windowMs: 60_000,
      },
      // Reporting a page (PR-013): a few an hour from one address is plenty for a real visitor.
      reports: {
        limit: this.config.RATE_LIMIT_REPORTS_PER_HOUR,
        windowMs: 3_600_000,
      },
      // One-click unsubscribe: mail providers post from shared addresses, so this is generous;
      // the signed token is what stops abuse.
      unsubscribe: {
        limit: this.config.RATE_LIMIT_UNSUBSCRIBE_PER_MIN,
        windowMs: 60_000,
      },
      // Photo and cover uploads (PR-013): each one is a full decode and re-encode.
      avatars: {
        limit: this.config.RATE_LIMIT_AVATARS_PER_HOUR,
        windowMs: 3_600_000,
      },
      // Per person, not per address: staff re-enter a code about every 5 minutes while working.
      ops_code: {
        limit: this.config.RATE_LIMIT_OPS_CODE_PER_HOUR,
        windowMs: 3_600_000,
      },
      // Per person: each ask can mail everyone who could decide it.
      ops_request: {
        limit: this.config.RATE_LIMIT_OPS_REQUEST_PER_HOUR,
        windowMs: 3_600_000,
      },
      // Each change writes and asks the web app to refresh the page. Generous and per address:
      // mobile carriers share addresses, and saving is a deliberate step, not browsing.
      cover_designs: {
        limit: this.config.RATE_LIMIT_COVER_DESIGNS_PER_HOUR,
        windowMs: 3_600_000,
      },
      // Each QR design is drawn on demand; the studio asks for a thumbnail of every design.
      qr_art: {
        limit: this.config.RATE_LIMIT_QR_ART_PER_HOUR,
        windowMs: 3_600_000,
      },
      // The list pictures count against the signed-in person, not the address, so a shop's wifi
      // or a carrier's shared address never runs out, and browsing never costs a print.
      qr_thumb: {
        limit: this.config.RATE_LIMIT_QR_THUMBS_PER_HOUR,
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
    // Counted per signed-in person: see ops_code, ops_request and qr_thumb above.
    const subject =
      (route === 'ops_code' ||
        route === 'ops_request' ||
        route === 'qr_thumb') &&
      request.auth
        ? `user:${request.auth.userId}`
        : ip;
    return this.count(route, subject, window);
  }

  /**
   * For a route where only some requests count, or that counts per person only once signed in:
   * `ops_request` (per hour) and `live_connect_user` (per minute). Both fail open, as count() does.
   */
  async consumeForPerson(
    route: 'ops_request' | 'live_connect_user',
    userId: string,
  ): Promise<void> {
    await this.count(
      route,
      `user:${userId}`,
      route === 'ops_request'
        ? {
            limit: this.config.RATE_LIMIT_OPS_REQUEST_PER_HOUR,
            windowMs: 3_600_000,
          }
        : { limit: LIVE_CONNECTS_PER_USER_PER_MIN, windowMs: 60_000 },
    );
  }

  private async count(
    route: RateLimitedRoute,
    subject: string,
    { limit, windowMs }: { limit: number; windowMs: number },
  ): Promise<boolean> {
    const now = Date.now();
    const key = `rl:${this.config.QUEUE_PREFIX}:${route}:${subject}:${Math.floor(now / windowMs)}`;
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
      if (route === 'bank_resolve')
        throw new CodedHttpException(503, 'PAYOUT_PROVIDER_UNAVAILABLE');
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
