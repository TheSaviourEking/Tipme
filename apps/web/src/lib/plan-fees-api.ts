import { cacheLife } from 'next/cache';
import { API_ORIGIN } from './profiles-api';
import {
  DEFAULT_PLAN_FEE_PERCENTS,
  planFeePercentsOf,
  type PlanFeePercents,
} from './fee-share';

/**
 * TipMe's fee per plan as staff set it (owner, 18 Nov 2026), for server-rendered copy. Cached for a
 * minute, like the API's own answer. When the API can't be read (at build, or down) the copy states
 * the coded defaults, which are the rates TipMe started with; the next read after that corrects it.
 * Quotes never use this: the API prices every tip from its database.
 */
export async function getPlanFees(): Promise<PlanFeePercents> {
  'use cache';
  cacheLife({ stale: 30, revalidate: 60, expire: 300 });
  try {
    const response = await fetch(`${API_ORIGIN}/v1/plan-fees`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return DEFAULT_PLAN_FEE_PERCENTS;
    const body = (await response.json()) as { data?: unknown };
    return planFeePercentsOf(body.data) ?? DEFAULT_PLAN_FEE_PERCENTS;
  } catch {
    return DEFAULT_PLAN_FEE_PERCENTS;
  }
}
