import type { PartnerQuoteCache, PartnerQuoteEntries } from '@tipme/database';
import type { Redis } from 'ioredis';
import { withTimeout } from '../infra/timeout.js';

export const PARTNER_QUOTE_CACHE = Symbol('PARTNER_QUOTE_CACHE');

type Scope = { provider: string; profileId: string };
type CacheRedis = Pick<Redis, 'get' | 'set' | 'multi'>;

// Far longer than any entry, so a version can never lapse back to one whose entries still live.
const VERSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * The quote's view of the provider, in Redis so every API copy shares it (the provider's rate
 * limit is shared with payouts). Each account has a version in every key; invalidating raises it.
 * Any store failure or stall is a miss, never an error: the quote then asks the provider.
 */
export class RedisPartnerQuoteCache implements PartnerQuoteCache {
  constructor(
    private readonly redis: CacheRedis,
    private readonly options: {
      prefix: string;
      seconds: number;
      timeoutMs: number;
    },
  ) {}

  private versionKey({ provider, profileId }: Scope): string {
    return `pq:${this.options.prefix}:${provider}:${profileId}:version`;
  }

  async open(scope: Scope): Promise<PartnerQuoteEntries | null> {
    const { seconds, timeoutMs, prefix } = this.options;
    if (seconds === 0) return null;
    let version: string | null;
    try {
      version = await withTimeout(
        this.redis.get(this.versionKey(scope)),
        timeoutMs,
      );
    } catch {
      return null;
    }
    const base = `pq:${prefix}:${scope.provider}:${scope.profileId}:${version ?? '0'}`;
    return {
      get: async (part) => {
        try {
          return await withTimeout(
            this.redis.get(`${base}:${part}`),
            timeoutMs,
          );
        } catch {
          return null;
        }
      },
      set: async (part, value) => {
        try {
          await withTimeout(
            this.redis.set(`${base}:${part}`, value, 'EX', seconds),
            timeoutMs,
          );
        } catch {
          // Not stored: the next quote asks the provider again.
        }
      },
    };
  }

  /**
   * Makes the account's next quote ask the provider. False when Redis could not be reached; the
   * stamp of TipMe's own records in every key still misses for any change TipMe has recorded.
   */
  async invalidate(scope: Scope): Promise<boolean> {
    const key = this.versionKey(scope);
    try {
      const results = await withTimeout(
        this.redis.multi().incr(key).expire(key, VERSION_TTL_SECONDS).exec(),
        this.options.timeoutMs,
      );
      return Boolean(results?.every(([error]) => !error));
    } catch {
      return false;
    }
  }
}
