'use client';
import type { MyAccount, MyBusinessRoles } from '@tipme/contracts';
import type { ReleaseFlags } from './business/available';
import { loadBusinessRoles } from './business/roles-api';
import { takeJoinCode } from './business/join-link';
import { loadMyInvitations, previewInvitation } from './business/members-api';
import { apiFetch } from './session-client';

/**
 * Business sign-up, Task D4: whether a signed-in login with no page may use the dashboard as
 * itself. Only with BUSINESS_SIGNUP_ENABLED, and only for someone who manages a business or has a
 * manager invitation (to their proven email, or a link kept through sign-in). Staff invitations
 * never count: staff need a page, so they choose a handle first, as today. null: go to /sign-up.
 */
export async function loadAccountOnly(flags: ReleaseFlags | null): Promise<{
  account: MyAccount;
  roles: MyBusinessRoles;
} | null> {
  if (!flags?.businessSignup) return null;
  const [account, roles] = await Promise.all([
    apiFetch<MyAccount>('/v1/me/account'),
    loadBusinessRoles(),
  ]);
  if (!account.ok || !roles) return null;
  const found = { account: account.data, roles };
  if (roles.manages.length > 0) return found;
  const invitations = await loadMyInvitations();
  if (
    invitations.ok &&
    invitations.data.invitations.some(
      (invitation) => invitation.kind === 'manager',
    )
  )
    return found;
  const code = takeJoinCode();
  if (!code) return null;
  const preview = await previewInvitation({ code });
  return preview.ok && preview.data.kind === 'manager' ? found : null;
}
