'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import type { OpsPage } from '@tipme/contracts';
import {
  Badge,
  Button,
  Card,
  InputField,
  Notice,
  TextareaField,
} from '@tipme/ui';
import { PagePricing } from '@/components/ops/page-pricing';
import { ReasonAction } from '@/components/ops/reason-action';
import { can, useOpsAccess } from '@/lib/ops-client';
import { apiFetch } from '@/lib/session-client';

const STATE_LABELS: Record<OpsPage['pageState'], string> = {
  live: 'Live',
  not_live: 'Not live',
  deleted: 'Deleted',
};

/** Someone lost their email and proved who they are to staff; the new address must prove itself. */
function MoveSignInEmail({ userId }: { userId: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (key: string) => String(data.get(key) ?? '').trim();
    const result = await apiFetch(`/v1/ops/accounts/${userId}/email-recovery`, {
      method: 'POST',
      body: {
        newEmail: text('newEmail'),
        checks: text('checks'),
        reason: text('reason'),
      },
    });
    if (result.ok) {
      setDone(true);
      setOpen(false);
    } else
      setError(
        result.code === 'FORBIDDEN'
          ? 'Staff accounts can’t be moved this way.'
          : 'That didn’t go through. Check the fields and try again.',
      );
  };
  return (
    <Card className="settings-section">
      <h2>Sign-in email</h2>
      {done && (
        <Notice tone="success" title="Started">
          A code was sent to the new address. Once they enter it at /recover,
          the move happens after 24 hours, and the old address is told.
        </Notice>
      )}
      {open ? (
        <form className="settings-form" onSubmit={(e) => void submit(e)}>
          <InputField
            id={`${id}-new`}
            name="newEmail"
            type="email"
            label="New sign-in email"
            maxLength={254}
            required
          />
          <TextareaField
            id={`${id}-checks`}
            name="checks"
            label="What did you check to be sure who this is?"
            minLength={10}
            maxLength={500}
            required
          />
          <TextareaField
            id={`${id}-reason`}
            name="reason"
            label="Why is this account moving?"
            hint="Recorded in the audit log with your name and the time."
            minLength={10}
            maxLength={500}
            required
          />
          {error && (
            <Notice tone="error" title="Not done">
              {error}
            </Notice>
          )}
          <Button type="submit">Send code to new email</Button>
        </form>
      ) : (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Move sign-in email…
        </Button>
      )}
    </Card>
  );
}

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
      {page?.userId && can(access, 'recoveries.manage') && (
        <MoveSignInEmail key={page.userId} userId={page.userId} />
      )}
      {page && can(access, 'fees.manage') && (
        <PagePricing key={page.profileId} profileId={page.profileId} />
      )}
    </div>
  );
}
