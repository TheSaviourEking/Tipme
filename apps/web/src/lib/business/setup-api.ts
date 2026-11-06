'use client';
import type {
  BusinessApplication,
  BusinessDetail,
  BusinessUpdate,
  LocationInput,
  LocationUpdate,
  ManagerRow,
} from '@tipme/contracts';
import { apiFetch } from '@/lib/session-client';

// Lane B1's calls (PR B1): applying, the business's details, locations and managers.

const base = (businessId: string) =>
  `/v1/me/businesses/${encodeURIComponent(businessId)}`;

export const applyForBusiness = (body: BusinessApplication) =>
  apiFetch<BusinessDetail>('/v1/me/businesses', { method: 'POST', body });

export const updateBusiness = (businessId: string, body: BusinessUpdate) =>
  apiFetch<BusinessDetail>(base(businessId), { method: 'PATCH', body });

export const addLocation = (businessId: string, body: LocationInput) =>
  apiFetch<BusinessDetail>(`${base(businessId)}/locations`, {
    method: 'POST',
    body,
  });

export const updateLocation = (
  businessId: string,
  locationId: string,
  body: LocationUpdate,
) =>
  apiFetch<BusinessDetail>(
    `${base(businessId)}/locations/${encodeURIComponent(locationId)}`,
    { method: 'PATCH', body },
  );

export const closeLocation = (businessId: string, locationId: string) =>
  apiFetch<BusinessDetail>(
    `${base(businessId)}/locations/${encodeURIComponent(locationId)}/close`,
    { method: 'POST', body: {} },
  );

export const listManagers = (businessId: string) =>
  apiFetch<ManagerRow[]>(`${base(businessId)}/managers`);

export const removeManager = (businessId: string, managerId: string) =>
  apiFetch<void>(
    `${base(businessId)}/managers/${encodeURIComponent(managerId)}/remove`,
    { method: 'POST', body: {} },
  );

/** Tells the dashboard's navigation to read the business roles again (a business was created). */
export const BUSINESS_ROLES_CHANGED = 'tipme:business-roles-changed';
export const announceRolesChanged = () =>
  window.dispatchEvent(new Event(BUSINESS_ROLES_CHANGED));
