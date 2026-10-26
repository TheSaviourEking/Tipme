'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { OpsMe } from '@tipme/contracts';
import { Button, Container, Skeleton } from '@tipme/ui';
import { OpsCode, OpsEnrol } from '@/components/ops/ops-steps';
import { PageUnavailable } from '@/components/page-unavailable';
import { OpsAccessContext, type OpsAccess } from '@/lib/ops-client';
import { apiFetch } from '@/lib/session-client';

const links = [
  { href: '/ops', label: 'Overview' },
  { href: '/ops/issues', label: 'Issues' },
  { href: '/ops/visibility', label: 'Visibility' },
  { href: '/ops/market', label: 'Market' },
  { href: '/ops/pages', label: 'Pages' },
  { href: '/ops/search', label: 'Search' },
  { href: '/ops/audit', label: 'Audit log' },
  { href: '/ops/staff', label: 'Staff & roles' },
] as const;

/** Where this visitor stands: signed out, not staff, the authenticator step, or in. */
async function opsState(): Promise<State | 'signed_out'> {
  const me = await apiFetch<OpsMe>('/v1/ops/me');
  if (me.ok)
    return me.data.state === 'granted'
      ? {
          step: 'granted',
          access: { role: me.data.role, permissions: me.data.permissions },
        }
      : { step: me.data.state };
  const session = await apiFetch('/v1/me/sessions');
  return session.status === 401 ? 'signed_out' : { step: 'unavailable' };
}

type State =
  | { step: 'loading' | 'unavailable' | 'needs_enrolment' | 'needs_code' }
  | { step: 'granted'; access: OpsAccess };

/**
 * The admin area. Signed out → sign in and come back; staff → the authenticator step, then the
 * pages; everyone else → the same "isn't available" screen as a missing page.
 */
export function OpsShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<State>({ step: 'loading' });

  const apply = useCallback(
    (next: State | 'signed_out') => {
      if (next === 'signed_out')
        router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
      else setState(next);
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

  if (state.step === 'unavailable') return <PageUnavailable />;
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
        {state.step === 'needs_enrolment' && <OpsEnrol onDone={reload} />}
        {state.step === 'needs_code' && <OpsCode onDone={reload} />}
        {state.step === 'granted' && (
          <>
            <div className="dashboard-bar">
              <nav aria-label="Admin" className="dashboard-nav">
                {links.map((link) => (
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
            <OpsAccessContext.Provider value={state.access}>
              {children}
            </OpsAccessContext.Provider>
          </>
        )}
      </Container>
    </main>
  );
}
