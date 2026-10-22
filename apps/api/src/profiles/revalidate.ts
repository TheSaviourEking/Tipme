import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@tipme/observability';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { LOGGER } from '../tokens.js';

/**
 * Tells the web app that a public profile changed, so its cached page refreshes within seconds.
 * Best effort: a web app that cannot be reached never fails the recipient's change.
 */
@Injectable()
export class ProfileRevalidator {
  private readonly url: string;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.url =
      config.WEB_REVALIDATE_URL ??
      `${new URL(config.WEB_ORIGIN).origin}/api/revalidate`;
  }

  /** Best effort, with one retry a second later (the web may be restarting). */
  revalidate(handle: string): void {
    if (!handle) return;
    void this.send(handle).then((ok) => {
      if (!ok) setTimeout(() => void this.send(handle), 1000).unref();
    });
  }

  /**
   * For a handle that just stopped being a page (PR-011 renames): now, and again two seconds later,
   * because a render of the old page already in flight could cache it once more after the first.
   */
  revalidateGone(handle: string): void {
    this.revalidate(handle);
    setTimeout(() => this.revalidate(handle), 2000).unref();
  }

  private send(handle: string): Promise<boolean> {
    return fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle,
        secret: this.config.WEB_REVALIDATE_SECRET,
      }),
      signal: AbortSignal.timeout(2000),
    })
      .then((response) => {
        if (!response.ok)
          this.logger.warn({
            event: 'profile.revalidate_failed',
            status: response.status,
          });
        return response.ok;
      })
      .catch(() => {
        this.logger.warn({ event: 'profile.revalidate_failed', status: 0 });
        return false;
      });
  }
}
