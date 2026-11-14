import { Inject, Injectable } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from './config.js';

/**
 * Pro page features behind a flag (plan 2026-11-14-pro-campaign-pages-goals-thankyous-statements).
 * The owner wants these as admin switches (PR #216, `featureOn(db, key)`), which isn't on dev yet.
 * Until it is, each key reads its environment setting here, and nothing else reads that setting.
 * When #216 lands: register the key in FEATURE_SWITCHES with `env: truthy('<VARIABLE>')` (the
 * variable then only seeds the switch) and make `isOn` return `featureOn(db, key)`. The call sites
 * already await it, so they don't change.
 */
export type ProPageFeature = 'campaign_pages';

const VARIABLE = {
  campaign_pages: 'CAMPAIGN_PAGES_ENABLED',
} as const satisfies Record<ProPageFeature, keyof ApiConfig>;

@Injectable()
export class FeatureFlags {
  constructor(
    @Inject(API_CONFIG)
    private readonly config: Pick<ApiConfig, (typeof VARIABLE)[ProPageFeature]>,
  ) {}

  /** Whether the feature is on for this copy now. Never throws. */
  isOn(key: ProPageFeature): Promise<boolean> {
    return Promise.resolve(this.config[VARIABLE[key]] === true);
  }
}
