import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

/**
 * Pro page features behind a switch (plan 2026-11-14-pro-campaign-pages-goals-thankyous-statements).
 * The owner wants these as admin switches (PR #216, `featureOn(db, key)`), which isn't on dev yet.
 * Until it is, this is a stand-in that no deployed copy can turn on: it is not an `ApiConfig`
 * setting and no Compose file or `.env` passes it, so production and staging are always off.
 * Only local runs and the e2e stack set `CAMPAIGN_PAGES_ENABLED=true`; integration tests pass
 * `features` to `createApp`.
 *
 * When #216 lands: register `campaign_pages` in FEATURE_SWITCHES (`env: truthy('CAMPAIGN_PAGES_ENABLED')`
 * seeds it once), make `isOn` return `featureOn(db, key)` and delete `proPageFeaturesFromEnv`. Call
 * sites already await `isOn`, so they don't change.
 */
export const PRO_PAGE_FEATURES = ['campaign_pages'] as const;
export type ProPageFeature = (typeof PRO_PAGE_FEATURES)[number];
export type ProPageFeatures = Record<ProPageFeature, boolean>;

export const PRO_PAGE_FEATURES_TOKEN = Symbol('PRO_PAGE_FEATURES');

export const NO_PRO_PAGE_FEATURES: ProPageFeatures = { campaign_pages: false };

const onOff = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/** Reads the stand-in from the process environment; anything but `true`/`false` is refused. */
export function proPageFeaturesFromEnv(
  env: Record<string, string | undefined>,
): ProPageFeatures {
  const parsed = onOff.safeParse(env['CAMPAIGN_PAGES_ENABLED'] || undefined);
  if (!parsed.success)
    throw new Error('Invalid configuration: CAMPAIGN_PAGES_ENABLED');
  return { campaign_pages: parsed.data };
}

@Injectable()
export class FeatureFlags {
  constructor(
    @Inject(PRO_PAGE_FEATURES_TOKEN)
    private readonly features: ProPageFeatures,
  ) {}

  /** Whether the feature is on for this copy now. Never throws. */
  isOn(key: ProPageFeature): Promise<boolean> {
    return Promise.resolve(this.features[key] === true);
  }
}
