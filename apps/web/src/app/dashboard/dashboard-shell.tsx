'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  BachsPaymentAccountStatus,
  MyProfile,
  RecoveryEmailStatus,
} from '@tipme/contracts';
import { Badge, Button, Container, Notice, Skeleton } from '@tipme/ui';
import { RecipientContext } from '@/components/account/recipient-context';
import { NotificationBell } from '@/components/dashboard/notification-bell';
import { LiveProvider } from '@/components/live/live-provider';
import { usePaymentMode } from '@/components/payment-mode-context';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import { ownerAttention, RECOVERY_EMAIL_CHANGED } from '@/lib/owner-attention';
import { apiFetch } from '@/lib/session-client';

/**
 * The dashboard's navigation: a segmented control on a desktop, the fixed four-item tab bar on a
 * phone (My QR is not in the bar: Show QR sits beside Withdraw on Home).
 */
const links = (handle: string | null) =>
  [
    { href: '/dashboard', label: 'Home', phone: true },
    { href: '/dashboard/tips', label: 'Tips', phone: true },
    ...(handle ? [{ href: `/@${handle}`, label: 'My page', phone: true }] : []),
    { href: '/dashboard/qr', label: 'My QR', phone: false },
    { href: '/dashboard/settings', label: 'Settings', phone: true },
  ] as const;

const isCurrent = (pathname: string, href: string) =>
  href === '/dashboard'
    ? pathname === href
    : !href.startsWith('/@') &&
      (pathname === href || pathname.startsWith(`${href}/`));

/**
 * Loads the signed-in recipient's page. Signed out → sign in (and come back here); signed in
 * without a page → choose a handle.
 */
export function DashboardShell({
  children,
  pilotNotice,
}: {
  children: React.ReactNode;
  /** The pilot notice, rendered on the server (null outside live mode). */
  pilotNotice?: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const copy = paymentModeCopy(usePaymentMode());
  const [profile, setProfile] = useState<MyProfile | null>(null);
  // From the first profile read only (later writes return a profile without it): with live updates
  // off, no stream is opened and the page makes exactly the requests it made before the feature.
  const [liveUpdates, setLiveUpdates] = useState(false);

  useEffect(() => {
    void apiFetch<MyProfile>('/v1/me/profile').then((result) => {
      if (result.ok) {
        setProfile(result.data);
        setLiveUpdates(result.data.liveUpdates === true);
      } else if (result.status === 404) router.replace('/sign-up');
      else router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
    });
  }, [router, pathname]);

  // Read on every page change too, so a finished setup clears its notice on the next click.
  const [payments, setPayments] = useState<
    BachsPaymentAccountStatus | null | undefined
  >(undefined);
  const refreshAttention = useCallback(() => {
    void apiFetch<BachsPaymentAccountStatus>('/v1/me/payment-account').then(
      (result) => setPayments(result.ok ? result.data : null),
    );
  }, []);
  useEffect(refreshAttention, [refreshAttention, pathname]);
  const [needsRecoveryEmail, setNeedsRecoveryEmail] = useState(false);
  useEffect(() => {
    const refresh = () =>
      void apiFetch<RecoveryEmailStatus>('/v1/me/recovery-email').then(
        (result) => setNeedsRecoveryEmail(result.ok && !result.data.confirmed),
      );
    refresh();
    window.addEventListener(RECOVERY_EMAIL_CHANGED, refresh);
    return () => window.removeEventListener(RECOVERY_EMAIL_CHANGED, refresh);
  }, [pathname]);
  const attention =
    profile && payments !== undefined
      ? ownerAttention({ profile, payments, needsRecoveryEmail })
      : null;
  const needsFix = new Set(attention?.map((item) => item.navHref));

  const signOut = async () => {
    await apiFetch('/v1/auth/sign-out', { method: 'POST', body: {} });
    router.replace('/sign-in');
  };

  // A session ended elsewhere (sign out other devices): the same redirect as a signed-out load.
  const signedOutElsewhere = useCallback(
    () => router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`),
    [router, pathname],
  );

  return (
    <main id="main" tabIndex={-1} className="dashboard-page">
      {/* Around the bar too: the bell is live. It connects once the profile has loaded. */}
      <LiveProvider
        stream="me"
        enabled={profile !== null && liveUpdates}
        onSignedOut={signedOutElsewhere}
      >
        <Container>
          {/* The welcome is a moment of its own: no dashboard toolbar around it. */}
          {pathname !== '/dashboard/welcome' && (
            <div className="dashboard-bar">
              <nav aria-label="Dashboard" className="dashboard-nav">
                {links(profile?.handle ?? null).map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={
                      isCurrent(pathname, link.href) ? 'page' : undefined
                    }
                    data-desktop-only={link.phone ? undefined : ''}
                  >
                    {link.label}
                    {needsFix.has(link.href) && (
                      <span className="dashboard-nav__dot">
                        <span className="sr-only"> (needs your attention)</span>
                      </span>
                    )}
                  </Link>
                ))}
              </nav>
              {copy.dashboardBadge && <Badge>{copy.dashboardBadge}</Badge>}
              {profile && <NotificationBell />}
              {profile && (
                <Button variant="quiet" onClick={() => void signOut()}>
                  Sign out
                </Button>
              )}
            </div>
          )}
          {/* Withdraw carries its own beside the Withdraw action. */}
          {pathname !== '/dashboard/welcome' &&
            pathname !== '/dashboard/withdraw' &&
            pilotNotice}
          {profile?.suspended && (
            <Notice tone="neutral" title="TipMe has paused your page">
              Visitors see “This page isn’t available right now” and nobody can
              start a new tip. Tips already on their way still reach you, and
              you can still withdraw your balance.
              {profile.suspendedReason && (
                <>
                  {' '}
                  Reason: <q>{profile.suspendedReason}</q>
                </>
              )}{' '}
              Questions? Reply to any TipMe email or contact support.
            </Notice>
          )}
          {/* Not on the welcome, which walks through the same steps itself. */}
          {attention &&
            attention.length > 0 &&
            pathname !== '/dashboard/welcome' && (
              <section
                className="owner-attention"
                aria-label="Needs your attention"
              >
                {attention.map((item) => (
                  <Notice key={item.id} tone="neutral" title={item.title}>
                    {item.body}
                    {item.action && (
                      <>
                        {' '}
                        <Link
                          className="tm-button tm-button--primary owner-attention__action"
                          href={item.action.href}
                        >
                          {item.action.label}
                        </Link>
                      </>
                    )}
                  </Notice>
                ))}
              </section>
            )}
          {profile ? (
            <RecipientContext.Provider
              value={{
                profile,
                setProfile,
                attention,
                refreshAttention,
                paymentsNeedSetup:
                  payments === undefined ? null : Boolean(payments?.enabled),
              }}
            >
              {children}
            </RecipientContext.Provider>
          ) : (
            <Skeleton label="Loading your dashboard" />
          )}
        </Container>
      </LiveProvider>
    </main>
  );
}
