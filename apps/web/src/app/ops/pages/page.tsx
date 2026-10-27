'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import type { OpsPage } from '@tipme/contracts';
import { Badge, Button, Card, InputField, Notice } from '@tipme/ui';
import { PagePricing } from '@/components/ops/page-pricing';
import { ReasonAction } from '@/components/ops/reason-action';
import { can, useOpsAccess } from '@/lib/ops-client';
import { apiFetch } from '@/lib/session-client';

const STATE_LABELS: Record<OpsPage['pageState'], string> = {
  live: 'Live',
  not_live: 'Not live',
  deleted: 'Deleted',
};

/** Free and Pro (PR-012): find a page by handle and change its plan. No billing; audited. */
export default function OpsPagesPage() {
  const id = useId();
  const access = useOpsAccess();
  const params = useSearchParams();
  const [handle, setHandle] = useState(params.get('handle') ?? '');
  const [page, setPage] = useState<OpsPage | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const allowed = can(access, 'pages.plan');

  const fetchPage = (wanted: string) =>
    apiFetch<OpsPage>(`/v1/ops/pages/${encodeURIComponent(wanted)}`);
  const show = (
    wanted: string,
    result: Awaited<ReturnType<typeof fetchPage>>,
  ) => {
    setBusy(false);
    if (result.ok) setPage(result.data);
    else {
      setPage(null);
      setError(
        result.status === 404
          ? `No page is called @${wanted}.`
          : 'We couldn’t look that up. Please try again.',
      );
    }
  };
  const lookup = async (raw: string) => {
    const wanted = raw.trim().replace(/^@/, '');
    if (!wanted) return;
    setBusy(true);
    setError('');
    setDone('');
    show(wanted, await fetchPage(wanted));
  };

  // Opened from Search with ?handle=: look it up straight away.
  const fromSearch = params.get('handle')?.trim().replace(/^@/, '') ?? '';
  useEffect(() => {
    if (allowed && fromSearch)
      void fetchPage(fromSearch).then((result) => show(fromSearch, result));
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!allowed)
    return (
      <Notice tone="neutral" title="Not part of your role">
        Changing a page’s plan needs the “pages.plan” permission.
      </Notice>
    );

  const find = async (event: FormEvent) => {
    event.preventDefault();
    await lookup(handle);
  };

  const changePlan = async (current: OpsPage, reason: string) => {
    const plan = current.plan === 'pro' ? 'free' : 'pro';
    const result = await apiFetch<OpsPage>(
      `/v1/ops/pages/${current.profileId}/plan`,
      { method: 'POST', body: { plan, reason } },
    );
    if (!result.ok) return 'That didn’t work. Please try again.';
    setPage(result.data);
    setDone(
      plan === 'pro'
        ? `@${result.data.handle} is now Pro: they can choose their own tip amounts in Settings.`
        : `@${result.data.handle} is back on Free: their page shows the standard amounts.`,
    );
    return null;
  };

  return (
    <div className="ops-dashboard">
      <h1>Pages</h1>
      <p className="tm-hint">
        Pro lets a recipient choose their own tip amounts and minimum (never
        below NGN 1,000). The fee and withdrawal minimum are the same as Free.
        There is no billing while payments are in test mode.
      </p>
      <form className="settings-form" onSubmit={(e) => void find(e)}>
        <InputField
          id={`${id}-handle`}
          label="Handle"
          autoComplete="off"
          spellCheck={false}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          error={error || undefined}
        />
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Find page
        </Button>
      </form>
      {done && (
        <Notice tone="success" title="Plan changed">
          {done}
        </Notice>
      )}
      {page && (
        <Card className="settings-section">
          <h2>
            {page.displayName} <span className="tm-hint">@{page.handle}</span>
          </h2>
          <p>
            <Badge>{page.plan === 'pro' ? 'Pro' : 'Free'}</Badge>{' '}
            {STATE_LABELS[page.pageState]}
            {page.suspended ? ' · Paused by TipMe' : ''}
          </p>
          <ReasonAction
            key={page.plan}
            open={page.plan === 'pro' ? 'Move back to Free…' : 'Make Pro…'}
            field={
              page.plan === 'pro'
                ? 'Why is this page going back to Free?'
                : 'Why is this page getting Pro?'
            }
            submit={page.plan === 'pro' ? 'Move to Free' : 'Make Pro'}
            onSubmit={(reason) => changePlan(page, reason)}
          />
        </Card>
      )}
      {page && can(access, 'fees.manage') && (
        <PagePricing key={page.profileId} profileId={page.profileId} />
      )}
    </div>
  );
}
