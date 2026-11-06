'use client';
import type {
  InvitationAccepted,
  InvitationAnswer,
  InvitationCreated,
  InvitationPreview,
  InvitationRequest,
  InvitationRow,
  InviteeCard,
  MemberDisplay,
  MemberRow,
  MyInvitations,
  MyMembership,
} from '@tipme/contracts';
import { apiFetch } from '@/lib/session-client';

// Business PR B3: the web's calls for invitations, the team and the Work page. An invitation's
// code only ever travels in a request body.

const business = (id: string) => `/v1/me/businesses/${encodeURIComponent(id)}`;
const member = (id: string) => `/v1/me/work/${encodeURIComponent(id)}`;

export const loadMembers = (businessId: string) =>
  apiFetch<MemberRow[]>(`${business(businessId)}/members`);
export const loadInvitations = (businessId: string) =>
  apiFetch<InvitationRow[]>(`${business(businessId)}/invitations`);
export const searchInvitees = (businessId: string, q: string) =>
  apiFetch<InviteeCard[]>(
    `${business(businessId)}/invitees?q=${encodeURIComponent(q)}`,
  );
export const invite = (businessId: string, body: InvitationRequest) =>
  apiFetch<InvitationCreated>(`${business(businessId)}/invitations`, {
    method: 'POST',
    body,
  });
export const revokeInvitation = (businessId: string, invitationId: string) =>
  apiFetch<null>(
    `${business(businessId)}/invitations/${encodeURIComponent(invitationId)}/revoke`,
    { method: 'POST', body: {} },
  );
export const removeMember = (businessId: string, memberId: string) =>
  apiFetch<null>(
    `${business(businessId)}/members/${encodeURIComponent(memberId)}/remove`,
    { method: 'POST', body: {} },
  );

export const loadWork = () => apiFetch<MyMembership[]>('/v1/me/work');
export const loadMyInvitations = () =>
  apiFetch<MyInvitations>('/v1/me/work/invitations');
export const previewInvitation = (answer: InvitationAnswer) =>
  apiFetch<InvitationPreview>('/v1/me/work/invitations/preview', {
    method: 'POST',
    body: answer,
  });
export const acceptInvitation = (answer: InvitationAnswer) =>
  apiFetch<InvitationAccepted>('/v1/me/work/invitations/accept', {
    method: 'POST',
    body: answer,
  });
export const declineInvitation = (answer: InvitationAnswer) =>
  apiFetch<null>('/v1/me/work/invitations/decline', {
    method: 'POST',
    body: answer,
  });
export const setInvitationBlock = (businessId: string, blocked: boolean) =>
  apiFetch<null>(
    `/v1/me/work/invitation-blocks/${encodeURIComponent(businessId)}`,
    { method: 'PUT', body: { blocked } },
  );
export const updateMembership = (memberId: string, patch: MemberDisplay) =>
  apiFetch<MyMembership>(member(memberId), { method: 'PATCH', body: patch });
export const leaveMembership = (memberId: string) =>
  apiFetch<null>(`${member(memberId)}/leave`, { method: 'POST', body: {} });

/** The Work page reloads its lists when a card changes what the person belongs to. */
export const WORK_CHANGED = 'tipme.work-changed';
export const workChanged = () => window.dispatchEvent(new Event(WORK_CHANGED));
