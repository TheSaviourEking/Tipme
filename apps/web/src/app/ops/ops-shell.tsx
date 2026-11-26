'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpsMe } from '@tipme/contracts';
import { Button, Container, Skeleton, Slip } from '@tipme/ui';
import {
  ApprovalsCount,
  useApprovalsCount,
} from '@/components/ops/approvals-count';
import { LiveProvider, OPS_LIVE_TIMING } from '@/components/live/live-provider';
import { FreshCodePrompt } from '@/components/ops/fresh-code';
import { OpsFrame } from '@/components/ops/ops-frame';
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
import { opsLiveEnabled } from '@/lib/live-enabled';
import { afterStreamEnd } from '@/lib/ops-stream-end';
import { apiFetch } from '@/lib/session-client';

/** Where this visitor stands: signed out, not staff, the authenticator step, or in. */
async function opsState(): Promise<State | 'signed_out'> {
  const me = await apiFetch<OpsMe>('/v1/ops/me');
  if (me.ok)
    return me.data.state === 'granted'
      ? {
          step: 'granted',
          access: {
            role: me.data.role,
            permissions: me.data.permissions,
            liveUpdates: me.data.liveUpdates === true,
          },
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
    <Slip
      dense
      tone="error"
      title="We couldn’t load the admin area"
      actions={
        <Button
          variant="secondary"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void retry()}
        >
          Try again
        </Button>
      }
    >
      {failed
        ? 'Still not loading. Please try again in a minute.'
        : 'This is usually brief.'}
    </Slip>
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
  // The staff stream ended (401/404): ask where this person stands. A passing failure of that
  // question keeps the admin area (and the page's filters and pages) showing and asks again with
  // backoff, so a later real answer (signed out, not staff) still takes effect.
  const recheck = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(recheck.current), []);
  const streamEnded = (attempt = 0) =>
    void opsState().then((next) => {
      const what = afterStreamEnd(next, attempt);
      if ('apply' in what) apply(next);
      else if ('recheckInMs' in what)
        recheck.current = window.setTimeout(
          () => streamEnded(attempt + 1),
          what.recheckInMs,
        );
    });

  const signOut = async () => {
    await apiFetch('/v1/ops/sign-out', { method: 'POST', body: {} });
    router.replace('/dashboard');
  };

  if (state.step === 'unavailable')
    return <PageUnavailable showDemo={mode === 'test'} />;
  if (state.step === 'granted')
    return (
      // Around OpsGranted, not only its frame: the menu's approvals count is read in OpsGranted's
      // own body, and useLiveEvents does nothing outside a provider. A stream that ends because
      // the grant did (404) asks /v1/ops/me again, which shows the step this person is now at.
      // Until the page reloads, its screens then use their own timers (the stream stays ended).
      <LiveProvider
        stream="ops"
        timing={OPS_LIVE_TIMING}
        enabled={opsLiveEnabled(state.access)}
        onSignedOut={() => streamEnded()}
      >
        <OpsGranted
          access={state.access}
          pathname={pathname}
          onLeave={() => void signOut()}
        >
          {children}
        </OpsGranted>
      </LiveProvider>
    );
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
      </Container>
    </main>
  );
}

/**
 * Inside the admin area: the frame, the menu's count and the pages. Mounted only once access is
 * granted, so the site's header and footer give way to the frame only then (`data-ops-frame`); a
 * visitor who isn't staff, and the sign-in steps, keep them.
 */
function OpsGranted({
  access,
  pathname,
  onLeave,
  children,
}: {
  access: OpsAccess;
  pathname: string;
  onLeave: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.opsFrame = 'on';
    return () => {
      delete root.dataset.opsFrame;
    };
  }, []);
  const approvals = useApprovalsCount(pathname);
  // TipMe for businesses: the Businesses entry shows only while the feature is on, which the
  // signed-in roles route says (404 while BUSINESS_ENABLED is off).
  const [business, setBusiness] = useState(false);
  useEffect(() => {
    void loadBusinessRoles().then((roles) => setBusiness(roles !== null));
  }, []);
  return (
    <OpsFrame
      permissions={access.permissions}
      features={{ business }}
      pathname={pathname}
      approvals={<ApprovalsCount count={approvals.count} />}
      onLeave={onLeave}
    >
      <FreshCodePrompt />
      <OpsAccessContext.Provider value={access}>
        {children}
      </OpsAccessContext.Provider>
    </OpsFrame>
  );
}
