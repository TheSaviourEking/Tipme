'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpsMe } from '@tipme/contracts';
import { Button, Container, Notice, Skeleton } from '@tipme/ui';
import { FreshCodePrompt } from '@/components/ops/fresh-code';
import { OpsCode, OpsEnrol } from '@/components/ops/ops-steps';
import { PageUnavailable } from '@/components/page-unavailable';
import { usePaymentMode } from '@/components/payment-mode-context';
import {
  ENROL_LINK_KEY,
  ENROL_LINK_PREFIX,
  clearEnrolLink,
  OpsAccessContext,
  PROVIDER_TEST_CONFIRM_PATH,
  PROVIDER_TEST_TOKEN_KEY,
  type OpsAccess,
} from '@/lib/ops-client';
import { loadBusinessRoles } from '@/lib/business/roles-api';
import { isTemporaryFailure, keepsEnrolLink } from '@/lib/ops-enrol-link';
import { opsMenu } from '@/lib/ops-menu';
import { apiFetch } from '@/lib/session-client';

/** Where this visitor stands: signed out, not staff, the authenticator step, or in. */
async function opsState(): Promise<State | 'signed_out'> {
  const me = await apiFetch<OpsMe>('/v1/ops/me');
  if (me.ok)
    return me.data.state === 'granted'
      ? {
          step: 'granted',
          access: { role: me.data.role, permissions: me.data.permissions },
        }
      : me.data.state === 'needs_enrolment'
        ? { step: 'needs_enrolment', canDecline: me.data.canDecline }
        : { step: me.data.state };
  if (isTemporaryFailure(me.status)) return { step: 'retry' };
  const session = await apiFetch('/v1/me/sessions');
  if (session.status === 401) return 'signed_out';
  return isTemporaryFailure(session.status)
    ? { step: 'retry' }
    : { step: 'unavailable' };
}

type State =
  | { step: 'loading' | 'unavailable' | 'retry' | 'needs_code' }
  | { step: 'needs_enrolment'; canDecline: boolean }
  | { step: 'granted'; access: OpsAccess };

/** A passing failure: asks again, says so while it does, and says so if it's still failing. */
function OpsRetry({
  onResult,
}: {
  onResult: (next: State | 'signed_out') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const retry = async () => {
    setBusy(true);
    const next = await opsState();
    setBusy(false);
    if (next !== 'signed_out' && next.step === 'retry') {
      setFailed(true);
      return;
    }
    onResult(next);
    // The button is gone, so focus goes to what replaced it.
    document.getElementById('main')?.focus();
  };
  return (
    <>
      <Notice tone="error" title="We couldn’t load the admin area">
        {failed
          ? 'Still not loading. Please try again in a minute.'
          : 'This is usually brief.'}
      </Notice>
      <Button
        variant="secondary"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void retry()}
      >
        Try again
      </Button>
    </>
  );
}

/**
 * The admin area. Signed out → sign in and come back; staff → the authenticator step, then the
 * pages; everyone else → the same "isn't available" screen as a missing page.
 */
export function OpsShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const mode = usePaymentMode();
  const pathname = usePathname();
  const [state, setState] = useState<State>({ step: 'loading' });
  const menu = useRef<HTMLElement>(null);
  const granted = state.step === 'granted';
  // The admin menu scrolls sideways: keep the open page's link in view.
  useEffect(() => {
    if (!granted) return;
    menu.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [granted, pathname]);

  // TipMe for businesses: the Businesses entry shows only while the feature is on, which the
  // signed-in roles route says (404 while BUSINESS_ENABLED is off).
  const [business, setBusiness] = useState(false);
  useEffect(() => {
    if (!granted) return;
    void loadBusinessRoles().then((roles) => setBusiness(roles !== null));
  }, [granted]);

  const apply = useCallback(
    (next: State | 'signed_out') => {
      if (next === 'signed_out') {
        // A fragment doesn't survive sign-in, and a token must never go in `next` (it reaches
        // logs), so a provider test link keeps its token in this tab until it comes back.
        if (pathname === PROVIDER_TEST_CONFIRM_PATH && location.hash) {
          try {
            sessionStorage.setItem(PROVIDER_TEST_TOKEN_KEY, location.hash);
          } catch {
            // Storage blocked: the link can simply be opened again once signed in.
          }
        }
        // The same for an emailed enrolment link: most people open it signed out.
        if (location.hash.startsWith(ENROL_LINK_PREFIX)) {
          try {
            sessionStorage.setItem(ENROL_LINK_KEY, location.hash);
          } catch {
            // Storage blocked: the link can simply be opened again once signed in.
          }
        }
        router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
      } else {
        // The enrolment step clears it itself, and a passing failure must not lose it.
        if (!keepsEnrolLink(next.step)) clearEnrolLink();
        setState(next);
      }
    },
    [router, pathname],
  );
  useEffect(() => {
    void opsState().then(apply);
  }, [apply]);
  const reload = () => void opsState().then(apply);

  const signOut = async () => {
    await apiFetch('/v1/ops/sign-out', { method: 'POST', body: {} });
    router.replace('/dashboard');
  };

  if (state.step === 'unavailable')
    return <PageUnavailable showDemo={mode === 'test'} />;
  return (
    <main id="main" tabIndex={-1} className="dashboard-page ops-page">
      <Container>
        <div className="ops-banner" role="note">
          <strong>Admin</strong>
          <span>Staff area · every view and action is recorded</span>
        </div>
        {state.step === 'loading' && (
          <Skeleton label="Loading the admin area" />
        )}
        {state.step === 'retry' && <OpsRetry onResult={apply} />}
        {state.step === 'needs_enrolment' && (
          <OpsEnrol onDone={reload} canDecline={state.canDecline} />
        )}
        {state.step === 'needs_code' && <OpsCode onDone={reload} />}
        {state.step === 'granted' && (
          <>
            <div className="dashboard-bar">
              <nav aria-label="Admin" className="dashboard-nav" ref={menu}>
                {opsMenu(state.access.permissions, { business }).map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={pathname === link.href ? 'page' : undefined}
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
              <Button variant="quiet" onClick={() => void signOut()}>
                Leave admin
              </Button>
            </div>
            <FreshCodePrompt />
            <OpsAccessContext.Provider value={state.access}>
              {children}
            </OpsAccessContext.Provider>
          </>
        )}
      </Container>
    </main>
  );
}
