'use client';
import type {
  BusinessShareRow,
  ShareAgreementView,
  ShareBps,
  ShareReport,
} from '@tipme/contracts';
import { apiFetch } from '@/lib/session-client';

// Business PR R2-C1: the web's calls for the share agreement. Off (404) unless both flags are on.

const shares = (businessId: string) =>
  `/v1/me/businesses/${encodeURIComponent(businessId)}/shares`;
const mine = (agreementId: string) =>
  `/v1/me/work/shares/${encodeURIComponent(agreementId)}`;

export const loadBusinessShares = (businessId: string) =>
  apiFetch<BusinessShareRow[]>(shares(businessId));
export const proposeShare = (
  businessId: string,
  memberId: string,
  businessBps: ShareBps,
) =>
  apiFetch<BusinessShareRow>(shares(businessId), {
    method: 'POST',
    body: { memberId, businessBps },
  });
export const answerSuggestedShare = (
  businessId: string,
  agreementId: string,
  answer: 'accept' | 'decline',
) =>
  apiFetch<BusinessShareRow>(
    `${shares(businessId)}/${encodeURIComponent(agreementId)}/${answer}`,
    { method: 'POST', body: {} },
  );

export const loadMyShares = () =>
  apiFetch<ShareAgreementView[]>('/v1/me/work/shares');
export const acceptShare = (agreementId: string) =>
  apiFetch<ShareAgreementView>(`${mine(agreementId)}/accept`, {
    method: 'POST',
    body: {},
  });
export const declineShare = (agreementId: string) =>
  apiFetch<null>(`${mine(agreementId)}/decline`, { method: 'POST', body: {} });
export const counterShare = (agreementId: string, businessBps: ShareBps) =>
  apiFetch<ShareAgreementView>(`${mine(agreementId)}/counter`, {
    method: 'POST',
    body: { businessBps },
  });
export const reportBusiness = (memberId: string, report: ShareReport) =>
  apiFetch<null>(
    `/v1/me/work/${encodeURIComponent(memberId)}/report-business`,
    { method: 'POST', body: report },
  );

/** "1 December 2026" for a `YYYY-MM-DD` Lagos date. */
export function shareDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

/** What a refusal means, in the person's words. */
export function shareProblem(code: string): string {
  switch (code) {
    case 'SHARE_CHANGE_TOO_SOON':
      return 'The split can change at most once a month. Try again next month.';
    case 'SHARE_NOT_ALLOWED':
      return 'That would change nothing, or a proposal is still waiting for its start date.';
    case 'SHARE_NOT_OPEN':
      return 'This proposal can’t be answered any more.';
    case 'BUSINESS_NOT_VERIFIED':
      return 'This business isn’t verified yet, so it can’t share tips.';
    default:
      return 'We couldn’t do that just now. Please try again.';
  }
}
