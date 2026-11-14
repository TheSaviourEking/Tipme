import { Inject, Injectable } from '@nestjs/common';
import type { FeatureSwitch } from '@tipme/contracts';
import { featureOn } from '@tipme/database';
import { DatabaseProvider } from './infra/database.js';

/**
 * Pro page features behind a switch (plan 2026-11-14-pro-campaign-pages-goals-thankyous-statements).
 * #220 shipped this as a stand-in until the admin switches (#216) landed; in merge train 2 `isOn`
 * became `featureOn(db, key)`: staff turn `campaign_pages` on at `/ops/switches`, and
 * `CAMPAIGN_PAGES_ENABLED` only seeds it on a database that has no row yet (local runs, the e2e
 * stack). No deploy file passes it.
 */
export type ProPageFeature = Extract<FeatureSwitch, 'campaign_pages'>;

@Injectable()
export class FeatureFlags {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  /** Whether the feature is on for this copy now. Never throws. */
  isOn(key: ProPageFeature): Promise<boolean> {
    return featureOn(this.database.db, key);
  }
}
