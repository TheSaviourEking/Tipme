'use client';
import { useReportWebVitals } from 'next/web-vitals';
import { reportVital } from '@/lib/analytics';

/** Sends real-user web vitals (PR-011) under the same consent rules as other analytics. */
export function WebVitalsReporter() {
  useReportWebVitals(reportVital);
  return null;
}
