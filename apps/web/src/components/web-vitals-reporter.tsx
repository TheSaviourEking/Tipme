'use client';
import { useReportWebVitals } from 'next/web-vitals';
import { reportVital } from '@/lib/analytics';
import { shouldReportWebVitals } from '@/lib/analytics-core';

/** Sends real-user web vitals (PR-011) under the same consent rules as other analytics. */
export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    if (
      shouldReportWebVitals(
        document.querySelector('.coming-soon-page') !== null,
      )
    )
      reportVital(metric);
  });
  return null;
}
