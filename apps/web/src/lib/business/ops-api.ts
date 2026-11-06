'use client';
import type {
  BusinessStatus,
  OpsBusinessContact,
  OpsBusinessDetail,
  OpsBusinessRow,
} from '@tipme/contracts';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

// TipMe for businesses, lane B2: the admin Businesses screens' calls. Every one goes through the
// admin client, so a fresh code is asked for when the server needs one.

/** Staff words for a status. A verified business is never called "approved" (M10). */
export const OPS_BUSINESS_STATUS_WORDS: Record<BusinessStatus, string> = {
  pending: 'Waiting to be verified',
  verified: 'Verified business',
  suspended: 'Paused by TipMe',
};

/** The list filter's choices, in the board's words. */
export const OPS_BUSINESS_FILTERS: {
  value: '' | BusinessStatus;
  label: string;
}[] = [
  { value: 'pending', label: 'Waiting' },
  { value: 'verified', label: 'Verified' },
  { value: 'suspended', label: 'Paused' },
  { value: '', label: 'All' },
];

export function listBusinesses(filter: { status?: string; q?: string }) {
  const query = new URLSearchParams();
  if (filter.status) query.set('status', filter.status);
  if (filter.q && filter.q.trim().length >= 2) query.set('q', filter.q.trim());
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return opsFetch<OpsBusinessRow[]>(`/v1/ops/businesses${suffix}`);
}

const path = (businessId: string, action = '') =>
  `/v1/ops/businesses/${encodeURIComponent(businessId)}${action}`;

export const loadBusiness = (businessId: string) =>
  opsFetch<OpsBusinessDetail>(path(businessId));

export const revealContact = (businessId: string, reason: string) =>
  opsFetch<OpsBusinessContact>(path(businessId, '/reveal'), {
    method: 'POST',
    body: { reason },
  });

/** Verify waits for a second person when one qualifies; suspend and restore apply at once. */
export const changeBusiness = (
  businessId: string,
  action: 'verify' | 'suspend' | 'restore',
  reason: string,
) =>
  opsAct<OpsBusinessDetail>(path(businessId, `/${action}`), {
    method: 'POST',
    body: { reason },
  });
