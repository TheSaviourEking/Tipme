'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  MAX_HANDLE_CHANGE_EXTRA,
  MAX_HANDLE_CHANGE_GRANT,
  type OpsPage,
  type OpsWithdrawalFreeze,
  type OpsWithdrawalFreezeState,
} from '@tipme/contracts';
import {
  Badge,
  Button,
  Card,
  InputField,
  Notice,
  TextareaField,
} from '@tipme/ui';
import { PageImages } from '@/components/ops/page-images';
import { PagePricing, ValueWithReason } from '@/components/ops/page-pricing';
import { ReasonAction } from '@/components/ops/reason-action';
import { usePaymentMode } from '@/components/payment-mode-context';
import { paymentModeCopy } from '@/lib/payment-mode-copy';
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

/** How many handle changes a page has used and may use; staff can allow more, with a reason. */
function HandleChanges({
  page,
  used,
  allowed,
  onGranted,
}: {
  page: OpsPage;
  used: number;
  allowed: number;
  onGranted: () => Promise<void>;
}) {
  const [done, setDone] = useState('');
  const grant = async (extra: number, reason: string) => {
    setDone('');
    const result = await apiFetch<{ allowed: number }>(
      `/v1/ops/pages/${encodeURIComponent(page.handle)}/handle-changes`,
      { method: 'POST', body: { extra, reason } },
    );
    if (!result.ok)
      return result.code === 'VALIDATION_FAILED'
        ? `Check the values: a reason of at least 10 characters is needed, and a page can have at most ${MAX_HANDLE_CHANGE_EXTRA} extra changes in total.`
        : 'That didn’t work. Please try again.';
    await onGranted();
    setDone(`@${page.handle} can now make ${result.data.allowed} in total.`);
    return null;
  };
  return (
    <Card className="settings-section">
      <h2>Handle changes</h2>
      <p>
        Handle changes:{' '}
        <strong>
          {used} of {allowed} used
        </strong>
        {page.plan === 'pro' ? '' : ' (only Pro pages can make them)'}
      </p>
      {done && (
        <Notice tone="success" title="Allowed">
          {done}
        </Notice>
      )}
      <ValueWithReason
        label="More changes to allow"
        hint={`Whole number, 1 to ${MAX_HANDLE_CHANGE_GRANT}. Added to what the page has now, up to ${MAX_HANDLE_CHANGE_EXTRA} extra in total.`}
        submit="Allow more changes"
        parse={(raw) => {
          const n = /^\d{1,2}$/.test(raw.trim()) ? Number(raw) : 0;
          return n >= 1 && n <= MAX_HANDLE_CHANGE_GRANT ? n : null;
        }}
        onSubmit={grant}
      />
    </Card>
  );
}

/** A reported takeover: stops withdrawals until the issue it opens is resolved. */
function FreezeWithdrawals({
  profileId,
  userId,
  mayEndSessions,
}: {
  profileId: string;
  userId: string | null;
  mayEndSessions: boolean;
}) {
  const [issueId, setIssueId] = useState('');
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    void apiFetch<OpsWithdrawalFreezeState>(
      `/v1/ops/pages/${profileId}/withdrawal-freeze`,
    ).then((result) => {
      if (result.ok && result.data.issueId) setIssueId(result.data.issueId);
    });
  }, [profileId]);
  const freeze = async (reason: string) => {
    const result = await apiFetch<OpsWithdrawalFreeze>(
      `/v1/ops/pages/${profileId}/withdrawal-freeze`,
      { method: 'POST', body: { reason } },
    );
    if (!result.ok) return 'That didn’t go through. Please try again.';
    setIssueId(result.data.issueId);
    return null;
  };
  const endSessions = async (reason: string) => {
    const result = await apiFetch(`/v1/ops/accounts/${userId}/end-sessions`, {
      method: 'POST',
      body: { reason },
    });
    if (!result.ok)
      return result.code === 'FORBIDDEN'
        ? 'Staff accounts can’t be signed out this way.'
        : 'That didn’t go through. Please try again.';
    setEnded(true);
    return null;
  };
  return (
    <Card className="settings-section">
      <h2>Reported account takeover</h2>
      <p className="tm-hint">
        A freeze stops new withdrawals, any not yet started, and bank changes,
        until the issue is resolved. A withdrawal already with the provider
        can’t be recalled. The recipient sees only that withdrawals are paused
        while support checks. Then: end the sessions, check the current bank,
        and mark any withdrawal the thief asked for as failed.
      </p>
      {issueId ? (
        <Notice tone="success" title="Withdrawals are frozen">
          Resolve <Link href={`/ops/issues/${issueId}`}>the issue</Link> once
          the real owner has the account back. Another report can still be
          recorded below.
        </Notice>
      ) : null}
      <ReasonAction
        open={issueId ? 'Record another report…' : 'Freeze withdrawals…'}
        field="Who reported it, and what did they say?"
        submit={issueId ? 'Record report' : 'Freeze withdrawals'}
        onSubmit={freeze}
      />
      {ended && (
        <Notice tone="success" title="Signed out everywhere">
          Every session on this account has ended.
        </Notice>
      )}
      {userId && mayEndSessions && !ended && (
        <ReasonAction
          open="End all sessions…"
          field="Why sign this account out everywhere?"
          submit="End all sessions"
          onSubmit={endSessions}
        />
      )}
    </Card>
  );
}

/** Free and Pro (PR-012): find a page by handle and change its plan. No billing; audited. */
export default function OpsPagesPage() {
  const id = useId();
  const copy = paymentModeCopy(usePaymentMode());
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
        below NGN 1,000) and change their handle. The fee and withdrawal minimum
        are the same as Free.
        {copy.opsBilling}
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
      {page?.images && can(access, 'pages.suspend') && (
        <PageImages
          key={`images-${page.profileId}`}
          page={page}
          images={page.images}
          onRemoved={async () => {
            const result = await fetchPage(page.handle);
            if (result.ok) setPage(result.data);
          }}
        />
      )}
      {page?.handleChanges && (
        <HandleChanges
          key={`handle-changes-${page.profileId}`}
          page={page}
          used={page.handleChanges.used}
          allowed={page.handleChanges.allowed}
          onGranted={async () => {
            const result = await fetchPage(page.handle);
            if (result.ok) setPage(result.data);
          }}
        />
      )}
      {page?.userId && can(access, 'recoveries.manage') && (
        <MoveSignInEmail key={page.userId} userId={page.userId} />
      )}
      {page && can(access, 'payouts.resolve') && (
        <FreezeWithdrawals
          key={page.profileId}
          profileId={page.profileId}
          userId={page.userId}
          mayEndSessions={can(access, 'recoveries.manage')}
        />
      )}
      {page && can(access, 'fees.manage') && (
        <PagePricing key={page.profileId} profileId={page.profileId} />
      )}
    </div>
  );
}
