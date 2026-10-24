'use client';
import { useEffect } from 'react';
import type { AnalyticsClientEvent, AnalyticsSurface } from '@tipme/contracts';
import { track } from '@/lib/analytics';

/**
 * Counts one anonymous view of a page (PRD v1.1 §11, PR-013): the landing page or checkout.
 * Nothing is sent when the browser asks not to be tracked.
 */
export function ViewTracker({
  name,
  surface,
}: {
  name: Extract<AnalyticsClientEvent, 'landing_viewed' | 'checkout_opened'>;
  surface?: AnalyticsSurface;
}) {
  useEffect(() => track(name, surface ? { surface } : {}), [name, surface]);
  return null;
}
