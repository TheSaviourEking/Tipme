'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type {
  BachsPaymentAccountStatus,
  MyProfile,
  RecoveryEmailStatus,
} from '@tipme/contracts';
import { Badge, Button, Container, Notice, Skeleton } from '@tipme/ui';
import { RecipientContext } from '@/components/account/recipient-context';
import { NotificationBell } from '@/components/dashboard/notification-bell';
import { ownerAttention } from '@/lib/owner-attention';
import { apiFetch } from '@/lib/session-client';

const links = [
  { href: '/dashboard', label: 'Home' },
  { href: '/dashboard/tips', label: 'Tips' },
  { href: '/dashboard/qr', label: 'My QR' },
  { href: '/dashboard/settings', label: 'Settings' },
] as const;

/**
 * Loads the signed-in recipient's page. Signed out → sign in (and come back here); signed in
 * without a page → choose a handle.
 */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [profile, setProfile] = useState<MyProfile | null>(null);

  useEffect(() => {
    void apiFetch<MyProfile>('/v1/me/profile').then((result) => {
      if (result.ok) setProfile(result.data);
      else if (result.status === 404) router.replace('/sign-up');
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
    void apiFetch<RecoveryEmailStatus>('/v1/me/recovery-email').then((result) =>
      setNeedsRecoveryEmail(result.ok && !result.data.confirmed),
    );
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

  return (
    <main id="main" tabIndex={-1} className="dashboard-page">
      <Container>
        {/* The welcome is a moment of its own: no dashboard toolbar around it. */}
        {pathname !== '/dashboard/welcome' && (
          <div className="dashboard-bar">
            <nav aria-label="Dashboard" className="dashboard-nav">
              {links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={pathname === link.href ? 'page' : undefined}
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
            <Badge>Test mode</Badge>
            {profile && <NotificationBell />}
            {profile && (
              <Button variant="quiet" onClick={() => void signOut()}>
                Sign out
              </Button>
            )}
          </div>
        )}
        {profile?.suspended && (
          <Notice tone="neutral" title="TipMe has paused your page">
            Visitors see “This page isn’t available right now” and nobody can
            start a new tip. Tips already on their way still reach you, and you
            can still withdraw your balance.
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
              aria-labelledby="owner-attention-title"
            >
              <h2 id="owner-attention-title" className="sr-only">
                Needs your attention
              </h2>
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
    </main>
  );
}
