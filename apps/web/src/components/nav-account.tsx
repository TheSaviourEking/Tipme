'use client';
import { usePathname } from 'next/navigation';
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ActionLink } from '@tipme/ui';
import { Arrow } from './brand';
import { apiFetch } from '@/lib/session-client';
import { loadBusinessRoles } from '@/lib/business/roles-api';
import { BUSINESS_ROLES_CHANGED } from '@/lib/business/setup-api';
import { readSignedInHint, SIGNED_IN_HINT_CHANGED } from '@/lib/signed-in-hint';

/**
 * Signed out: "Sign in" and the one primary action, "Claim your username" ("Get tipped" with
 * business sign-up on, owner 14 Nov 2026).
 */
export function GuestActions({
  onClick,
  claimWords = 'Claim your username',
  businessStart = null,
}: {
  onClick(): void;
  /** The primary action's words, rendered on the server per request (GetTippedWords). */
  claimWords?: ReactNode;
  /** The header's "For businesses" with business sign-up on (HeaderBusinessStart). */
  businessStart?: ReactNode;
}) {
  return (
    <>
      {/* Business sign-up (owner, 14 Nov 2026): the header's "For businesses" opens the business
          path of sign-up. A plain link, so "Get tipped" stays the one purple action. */}
      {businessStart}
      {/* Hidden in the dashboard, where someone already has a page (CSS). */}
      <ActionLink
        className="nav-guest"
        variant="secondary"
        href="/sign-in"
        onClick={onClick}
      >
        Sign in
      </ActionLink>
      <ActionLink
        className="nav-guest nav-claim"
        href="/sign-up"
        onClick={onClick}
      >
        {claimWords} <Arrow />
      </ActionLink>
    </>
  );
}

/** The hint changes on any API answer in this tab, or in another tab (the storage event). */
function subscribeToHint(onChange: () => void) {
  window.addEventListener(SIGNED_IN_HINT_CHANGED, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(SIGNED_IN_HINT_CHANGED, onChange);
    window.removeEventListener('storage', onChange);
  };
}

const DASHBOARD = '/dashboard';
const BUSINESS = '/dashboard/business';

/**
 * The header's own actions. Signed out (or never signed in on this browser) they are Sign in and
 * Claim your username; signed in they are "Go to my dashboard", plus "Business" for someone who
 * runs one (the owner, 6 Nov 2026). A link to the page already on screen is left out.
 *
 * Whether someone is signed in comes from the browser's hint (signed-in-hint), so a visitor makes no
 * extra request. Outside the dashboard a hint is checked once against the API: an ended session
 * turns the header back to Sign in. Inside it the dashboard's own reads keep the hint right.
 */
export function NavAccount({
  onClick,
  claimWords,
  businessStart,
}: {
  onClick(): void;
  claimWords?: ReactNode;
  businessStart?: ReactNode;
}) {
  const pathname = usePathname();
  const inDashboard =
    pathname === DASHBOARD || pathname.startsWith(`${DASHBOARD}/`);
  const member = useSyncExternalStore(
    subscribeToHint,
    readSignedInHint,
    // The server can't know: it renders the signed-out pair.
    () => false,
  );
  const [business, setBusiness] = useState(false);
  // Where the visit began: the check below runs on arriving, not on every page change.
  const [arrivedInDashboard] = useState(inDashboard);

  // Once per visit outside the dashboard: a 401 clears the hint (session-client), and the
  // header shows Sign in again.
  useEffect(() => {
    if (!readSignedInHint() || arrivedInDashboard) return;
    void apiFetch('/v1/me/profile');
  }, [arrivedInDashboard]);

  useEffect(() => {
    if (!member) return;
    // While TipMe for businesses is off the API answers 404, and no Business link shows.
    const refresh = () =>
      void loadBusinessRoles().then((roles) =>
        setBusiness(Boolean(roles && roles.manages.length > 0)),
      );
    refresh();
    window.addEventListener(BUSINESS_ROLES_CHANGED, refresh);
    return () => window.removeEventListener(BUSINESS_ROLES_CHANGED, refresh);
  }, [member]);

  if (!member)
    return (
      <GuestActions
        onClick={onClick}
        claimWords={claimWords}
        businessStart={businessStart}
      />
    );
  // A Business answer from before a sign-out is never shown: `member` gates it.
  const onBusiness =
    pathname === BUSINESS || pathname.startsWith(`${BUSINESS}/`);
  return (
    <>
      {business && !onBusiness ? (
        <ActionLink
          className="nav-member"
          variant="secondary"
          href={BUSINESS}
          onClick={onClick}
        >
          Business
        </ActionLink>
      ) : null}
      {pathname !== DASHBOARD ? (
        <ActionLink className="nav-member" href={DASHBOARD} onClick={onClick}>
          Go to my dashboard <Arrow />
        </ActionLink>
      ) : null}
    </>
  );
}
