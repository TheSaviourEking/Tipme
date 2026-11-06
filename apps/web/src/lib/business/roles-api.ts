'use client';
import type { MyBusinessRoles } from '@tipme/contracts';
import { apiFetch } from '@/lib/session-client';

/**
 * The signed-in person's business roles (PR B0). While BUSINESS_ENABLED is off the API answers
 * 404, and this gives null: no Business or Work link, nothing else changes.
 */
export async function loadBusinessRoles(): Promise<MyBusinessRoles | null> {
  const result = await apiFetch<MyBusinessRoles>('/v1/me/business-roles');
  if (!result.ok) return null;
  const data = result.data as Partial<MyBusinessRoles> | null;
  // A stub or an older API may answer something else: only a real answer shows links.
  if (
    !data ||
    !Array.isArray(data.manages) ||
    !Array.isArray(data.works) ||
    typeof data.invitations !== 'number'
  )
    return null;
  return data as MyBusinessRoles;
}

/** The dashboard links the roles open: Business for managers, Work for staff and the invited. */
export function businessLinks(roles: MyBusinessRoles | null): {
  business: boolean;
  work: boolean;
} {
  return {
    business: Boolean(roles && roles.manages.length > 0),
    work: Boolean(roles && (roles.works.length > 0 || roles.invitations > 0)),
  };
}
