'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  BachsPaymentAccountStatus,
  MyProfile,
  RecoveryEmailStatus,
} from '@tipme/contracts';
import { Button, Container, Notice, Skeleton } from '@tipme/ui';
import { RecipientContext } from '@/components/account/recipient-context';
import { NotificationBell } from '@/components/dashboard/notification-bell';
import { TestModePill } from '@/components/dashboard/test-mode-pill';
import {
  useWhatsNewLoader,
  WhatsNewContext,
} from '@/components/dashboard/whats-new-context';
import { LiveProvider, useLiveEvents } from '@/components/live/live-provider';
import { liveProviderEnabled } from '@/lib/live-enabled';
import { usePaymentMode } from '@/components/payment-mode-context';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
import {
  attentionHere,
  ownerAttention,
  RECOVERY_EMAIL_CHANGED,
} from '@/lib/owner-attention';
import { apiFetch } from '@/lib/session-client';
import { businessLinks, loadBusinessRoles } from '@/lib/business/roles-api';
import { BUSINESS_ROLES_CHANGED } from '@/lib/business/setup-api';
import { keepJoinLink, takeJoinCode } from '@/lib/business/join-link';
import { hasNewUpdates } from '@/lib/whats-new';

const WHATS_NEW = '/dashboard/whats-new';

/**
 * The dashboard's navigation: a segmented control on a desktop, the fixed four-item tab bar on a
 * phone (My QR is not in the bar: Show QR sits beside Withdraw on Home; What's new is a small link
 * beside the bell instead, owner's answer of 6 Nov 2026).
 */
const links = (
  handle: string | null,
  business: { business: boolean; work: boolean } = {
    business: false,
    work: false,
  },
) =>
  [
    { href: '/dashboard', label: 'Home', phone: true },
    { href: '/dashboard/tips', label: 'Tips', phone: true },
    // Pro insights: earnings for everyone (the basics on Free), and campaign links.
    { href: '/dashboard/earnings', label: 'Earnings', phone: false },
    { href: '/dashboard/campaigns', label: 'Campaigns', phone: false },
    ...(handle ? [{ href: `/@${handle}`, label: 'My page', phone: true }] : []),
    { href: '/dashboard/qr', label: 'My QR', phone: false },
    // TipMe for businesses: only for someone who manages one, or works at or is invited to one.
    // Never in the phone's four-item bar.
    ...(business.business
      ? [{ href: '/dashboard/business', label: 'Business', phone: false }]
      : []),
    ...(business.work
      ? [{ href: '/dashboard/work', label: 'Work', phone: false }]
      : []),
    { href: WHATS_NEW, label: 'What’s new', phone: false },
    { href: '/dashboard/settings', label: 'Settings', phone: true },
    { href: '/dashboard/help', label: 'Get help', phone: false },
  ] as const;

/** The dot after an update goes live, with words for screen readers. */
const newUpdatesDot = (
  <span className="dashboard-nav__dot">
    <span className="sr-only"> (new updates)</span>
  </span>
);

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
      } else {
        // A business invitation's link (`#join=`) is a fragment: it survives sign-in only in
        // this tab's storage, and never in `next`.
        keepJoinLink();
        if (result.status === 404) router.replace('/sign-up');
        else router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
      }
    });
  }, [router, pathname]);

  // Once per dashboard load: while BUSINESS_ENABLED is off the API answers 404 and no link shows.
  const [business, setBusiness] = useState({ business: false, work: false });
  useEffect(() => {
    const refresh = () =>
      void loadBusinessRoles().then((roles) => {
        const links = businessLinks(roles);
        // An invitation link kept through sign-in (or sign-up) leads to Work, where it is answered.
        setBusiness(roles && takeJoinCode() ? { ...links, work: true } : links);
      });
    refresh();
    // Again after creating a business (PR B1), so its Business link shows without a reload.
    window.addEventListener(BUSINESS_ROLES_CHANGED, refresh);
    return () => window.removeEventListener(BUSINESS_ROLES_CHANGED, refresh);
  }, []);

  // Read on every page change too, so a finished setup clears its notice on the next click.
  const [payments, setPayments] = useState<
    BachsPaymentAccountStatus | null | undefined
  >(undefined);
  const readPayments = useCallback(
    () =>
      apiFetch<BachsPaymentAccountStatus>('/v1/me/payment-account').then(
        (result) => setPayments(result.ok ? result.data : null),
      ),
    [],
  );
  const refreshAttention = useCallback(
    () => void readPayments(),
    [readPayments],
  );
  useEffect(refreshAttention, [refreshAttention, pathname]);
  const [needsRecoveryEmail, setNeedsRecoveryEmail] = useState(false);
  const [accountRound, setAccountRound] = useState(0);
  useEffect(() => {
    const refresh = () =>
      void apiFetch<RecoveryEmailStatus>('/v1/me/recovery-email').then(
        (result) => setNeedsRecoveryEmail(result.ok && !result.data.confirmed),
      );
    refresh();
    window.addEventListener(RECOVERY_EMAIL_CHANGED, refresh);
    return () => window.removeEventListener(RECOVERY_EMAIL_CHANGED, refresh);
  }, [pathname, accountRound]);
  // Plan, suspension and page edits from staff, another tab or another device (live updates).
  const readProfile = useCallback(async () => {
    const result = await apiFetch<MyProfile>('/v1/me/profile');
    if (result.ok) setProfile(result.data);
  }, []);
  const attention =
    profile && payments !== undefined
      ? ownerAttention({ profile, payments, needsRecoveryEmail })
      : null;
  // The nav dots keep the full list; the reminders shown are this page's own.
  const needsFix = new Set(attention?.map((item) => item.navHref));
  const shown = attentionHere(attention, pathname);
  // Read once the profile has loaded (the person is known), and again after a seen call.
  const whatsNew = useWhatsNewLoader(profile?.handle ?? null);
  const newUpdates = hasNewUpdates(whatsNew.status);

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
    <main
      id="main"
      tabIndex={-1}
      className="dashboard-page"
      data-area="recipient"
    >
      {/* Around the bar too: the bell is live. It connects once the profile has loaded. */}
      <LiveProvider
        stream="me"
        enabled={liveProviderEnabled({ profile, liveUpdates })}
        onSignedOut={signedOutElsewhere}
      >
        <LiveShellSync
          onProfile={readProfile}
          onPayments={readPayments}
          onAccount={() => setAccountRound((n) => n + 1)}
        />
        <Container>
          {/* The welcome is a moment of its own: no dashboard toolbar around it. */}
          {pathname !== '/dashboard/welcome' && (
            <div className="dashboard-bar">
              <nav aria-label="Dashboard" className="dashboard-nav">
                {links(profile?.handle ?? null, business).map((link) => (
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
                    {link.href === WHATS_NEW && newUpdates && newUpdatesDot}
                  </Link>
                ))}
              </nav>
              {copy.dashboardBadge && (
                <TestModePill
                  label={copy.dashboardBadge}
                  detail={copy.dashboardBadgeDetail}
                  sentence={copy.withdrawNotice}
                />
              )}
              {/* Phones only: the tab bar stays four items, so What's new sits beside the bell. */}
              {profile && (
                <Link
                  href={WHATS_NEW}
                  className="dashboard-bar__whats-new"
                  aria-current={
                    isCurrent(pathname, WHATS_NEW) ? 'page' : undefined
                  }
                >
                  What’s new
                  {newUpdates && newUpdatesDot}
                </Link>
              )}
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
          {shown && shown.length > 0 && pathname !== '/dashboard/welcome' && (
            <section
              className="owner-attention"
              aria-label="Needs your attention"
            >
              {shown.map((item) => (
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
            <WhatsNewContext.Provider value={whatsNew}>
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
            </WhatsNewContext.Provider>
          ) : (
            <Skeleton label="Loading your dashboard" />
          )}
        </Container>
      </LiveProvider>
    </main>
  );
}

const PROFILE_CHANGED = ['profile.changed'] as const;
const PAYMENTS_CHANGED = ['payments.changed'] as const;
const ACCOUNT_CHANGED = ['account.changed'] as const;

/**
 * The shell's own reads, inside the live provider. The profile is also read on every resync: the
 * paused-page notice and the plan must not stay wrong after a dropped signal. The payment account
 * and recovery email only on their signals: they are read again on every page change anyway.
 */
function LiveShellSync({
  onProfile,
  onPayments,
  onAccount,
}: {
  onProfile: () => Promise<void>;
  onPayments: () => Promise<void>;
  onAccount: () => void;
}) {
  useLiveEvents(PROFILE_CHANGED, onProfile);
  useLiveEvents(PAYMENTS_CHANGED, onPayments, { resync: false });
  useLiveEvents(ACCOUNT_CHANGED, async () => onAccount(), { resync: false });
  return null;
}
