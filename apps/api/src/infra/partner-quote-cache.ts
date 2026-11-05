import type { PartnerQuoteCache, PartnerQuoteEntries } from '@tipme/database';
import type { Redis } from 'ioredis';
import { withTimeout } from './timeout.js';

export const PARTNER_QUOTE_CACHE = Symbol('PARTNER_QUOTE_CACHE');

type Scope = { provider: string; profileId: string };
type CacheRedis = Pick<Redis, 'get' | 'set' | 'multi'>;

// The entries' format. Raise it when what an entry means changes, so copies on either side of a
// rolling deploy never read each other's entries.
const FORMAT = 'pq1';

// Far longer than any entry, so a version can never lapse back to one whose entries still live.
const VERSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * The quote's view of the provider, in Redis so every API copy shares it (the provider's rate
 * limit is shared with payouts). Each account has a version in every key; invalidating raises it.
 * Any store failure or stall is a miss, never an error: the quote then asks the provider. One
 * quote gets one time budget for all its reads together, and writes are never waited for.
 */
export class RedisPartnerQuoteCache implements PartnerQuoteCache {
  constructor(
    private readonly redis: CacheRedis,
    private readonly options: {
      prefix: string;
      seconds: number;
      budgetMs: number;
    },
  ) {}

  private key(scope: Scope, rest: string): string {
    return `${FORMAT}:${this.options.prefix}:${scope.provider}:${scope.profileId}:${rest}`;
  }

  async open(scope: Scope): Promise<PartnerQuoteEntries | null> {
    const { seconds, budgetMs } = this.options;
    if (seconds === 0) return null;
    const deadline = performance.now() + budgetMs;
    /** What is left of this quote's budget, or a miss straight away once it is spent. */
    const inBudget = <T>(command: () => Promise<T>): Promise<T> => {
      const left = deadline - performance.now();
      if (left <= 0) return Promise.reject(new Error('budget spent'));
      return withTimeout(command(), left);
    };
    let version: string | null;
    try {
      version = await inBudget(() =>
        this.redis.get(this.key(scope, 'version')),
      );
    } catch {
      return null;
    }
    const base = this.key(scope, version ?? '0');
    return {
      get: async (part) => {
        try {
          return await inBudget(() => this.redis.get(`${base}:${part}`));
        } catch {
          return null;
        }
      },
      set: (part, value) => {
        // Not awaited, and bounded by the same timeout so a stalled write doesn't pile up.
        withTimeout(
          this.redis.set(`${base}:${part}`, value, 'EX', seconds),
          budgetMs,
        ).catch(() => undefined);
        return Promise.resolve();
      },
    };
  }

  /**
   * Makes the account's next quote ask the provider. False when Redis could not be reached; the
   * stamp of TipMe's own records in every key still misses for any change TipMe has recorded.
   */
  async invalidate(scope: Scope): Promise<boolean> {
    // Nothing is stored while the cache is off, so there is nothing to clear.
    if (this.options.seconds === 0) return true;
    const key = this.key(scope, 'version');
    try {
      const results = await withTimeout(
        this.redis.multi().incr(key).expire(key, VERSION_TTL_SECONDS).exec(),
        this.options.budgetMs,
      );
      return Boolean(results?.every(([error]) => !error));
    } catch {
      return false;
    }
  }
}
