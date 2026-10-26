'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { MyTipRow, OpsAccountDetail } from '@tipme/contracts';
import {
  Button,
  Card,
  InputField,
  Notice,
  Skeleton,
  TextareaField,
} from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import { bpsToPercent, percentToBps } from '@/lib/fee-percent';
import { naira } from '@/lib/money';
import { can, useOpsAccess, when } from '@/lib/ops-client';
import { apiFetch } from '@/lib/session-client';

const STANDARD_BPS = 1000;

interface PageReport {
  id: string;
  reason: string;
  details: string | null;
  createdAt: string;
}
const REPORT_REASONS: Record<string, string> = {
  impersonation: 'Pretending to be someone else',
  scam: 'Scam or misleading page',
  abusive: 'Abusive or hateful content',
  other: 'Something else',
};

const problem = (code: string) =>
  code === 'FORBIDDEN'
    ? 'Your role can’t do that.'
    : code === 'VALIDATION_FAILED'
      ? 'Check the values: a reason of at least 10 characters is needed.'
      : 'That didn’t work. Please try again.';

/** A value and a written reason, sent together (every pricing change is audited). */
function ValueWithReason({
  label,
  hint,
  submit,
  parse,
  onSubmit,
}: {
  label: string;
  hint: string;
  submit: string;
  parse: (raw: string) => number | null;
  onSubmit: (value: number, reason: string) => Promise<string | null>;
}) {
  const id = useId();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = parse(String(data.get('value') ?? ''));
    const reason = String(data.get('reason') ?? '').trim();
    if (value === null) return setError(`Check the ${label.toLowerCase()}.`);
    if (reason.length < 10)
      return setError('Please write a reason of at least 10 characters.');
    setBusy(true);
    setError('');
    const failed = await onSubmit(value, reason);
    setBusy(false);
    if (failed) setError(failed);
    else form.reset();
  };
  return (
    <form className="ops-reason" onSubmit={(e) => void send(e)} noValidate>
      <InputField id={`${id}-value`} name="value" label={label} hint={hint} />
      <TextareaField
        id={`${id}-reason`}
        name="reason"
        label="Reason"
        hint="Recorded in the audit log with your name and the time."
        maxLength={500}
      />
      {error && (
        <Notice tone="error" title="Not done">
          {error}
        </Notice>
      )}
      <Button type="submit" disabled={busy} aria-busy={busy}>
        {submit}
      </Button>
    </form>
  );
}

export default function OpsAccountPage() {
  const { profileId } = useParams<{ profileId: string }>();
  const access = useOpsAccess();
  const [account, setAccount] = useState<OpsAccountDetail | null>(null);
  const [tips, setTips] = useState<MyTipRow[] | null>(null);
  const [reports, setReports] = useState<PageReport[]>([]);
  const [missing, setMissing] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(
    () =>
      Promise.all([
        apiFetch<OpsAccountDetail>(`/v1/ops/accounts/${profileId}`),
        apiFetch<{ items: MyTipRow[] }>(`/v1/ops/accounts/${profileId}/tips`),
        apiFetch<PageReport[]>(`/v1/ops/accounts/${profileId}/reports`),
      ]),
    [profileId],
  );

  const applyLoad = useCallback(
    ([detail, list, reported]: Awaited<ReturnType<typeof load>>) => {
      if (detail.ok) setAccount(detail.data);
      else setMissing(true);
      if (list.ok) setTips(list.data.items);
      if (reported.ok) setReports(reported.data);
    },
    [],
  );

  useEffect(() => {
    let current = true;
    void load().then((result) => {
      if (current) applyLoad(result);
    });
    return () => {
      current = false;
    };
  }, [applyLoad, load]);

  const act = async (path: string, body: unknown, done: string) => {
    const result = await apiFetch(path, { method: 'POST', body });
    if (!result.ok) return problem(result.code);
    setMessage(done);
    applyLoad(await load());
    return null;
  };

  if (missing)
    return (
      <Notice tone="error" title="We couldn’t find that account">
        <Link href="/ops/accounts">Back to accounts</Link>
      </Notice>
    );
  if (!account) return <Skeleton label="Loading the account" />;

  const fee = account.platformFeeBps ?? STANDARD_BPS;
  const base = `/v1/ops/pages/${account.profileId}`;
  return (
    <div className="dashboard-section ops-account">
      <Link href="/ops/accounts">← Accounts</Link>
      <h1>{account.displayName}</h1>
      <p>
        @{account.handle}
        {account.role ? ` · ${account.role}` : ''} · joined{' '}
        {when(account.createdAt)}
      </p>
      {message && (
        <Notice tone="success" title="Done">
          {message}
        </Notice>
      )}

      <div className="ops-tiles">
        <Card className="ops-tile">
          <p className="ops-tile__label">Page</p>
          <p className="ops-tile__value">
            {account.status === 'suspended'
              ? 'Paused'
              : account.pageState === 'live'
                ? 'Live'
                : 'Not live'}
          </p>
          {account.suspendedReason && (
            <p className="tm-hint">Reason: {account.suspendedReason}</p>
          )}
        </Card>
        <Card className="ops-tile">
          <p className="ops-tile__label">Paid tips</p>
          <p className="ops-tile__value">{account.paidTipCount}</p>
          <p className="tm-hint">{naira(account.paidGrossMinor)} tipped</p>
        </Card>
        <Card className="ops-tile">
          <p className="ops-tile__label">Balance</p>
          <p className="ops-tile__value">{naira(account.availableMinor)}</p>
          <p className="tm-hint">
            {naira(account.confirmingMinor)} still confirming
          </p>
        </Card>
      </div>

      {reports.length > 0 && (
        <Card className="settings-section">
          <h2>Reports about this page</h2>
          <ul className="activity-list">
            {reports.map((report) => (
              <li key={report.id}>
                <div className="activity-list__row">
                  <span>
                    {REPORT_REASONS[report.reason] ?? report.reason}
                    {report.details && <small>“{report.details}”</small>}
                  </span>
                  <span className="tm-hint">{when(report.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="settings-section">
        <h2>Pricing</h2>
        <p>
          TipMe fee: <strong>{bpsToPercent(fee)}</strong>
          {account.platformFeeBps === null
            ? ' (standard)'
            : ' (set by staff for this account)'}
          {' · '}Fee-free tips left: <strong>{account.feeFreeRemaining}</strong>
        </p>
        <p className="tm-hint">
          Changes apply to new tips only; a price already shown to a supporter
          is kept. Nothing here is automatic.
        </p>
        {can(access, 'fees.manage') ? (
          <>
            <ValueWithReason
              label="New TipMe fee (%)"
              hint="For example 8 or 7.5. Use 10 for the standard fee."
              submit="Set this account’s fee"
              parse={percentToBps}
              onSubmit={(bps, reason) =>
                act(
                  `${base}/fee`,
                  { feeBps: bps, reason },
                  `The fee is now ${bpsToPercent(bps)} for new tips.`,
                )
              }
            />
            {account.platformFeeBps !== null && (
              <ReasonAction
                open="Return to the standard 10%"
                field="Why return to the standard fee?"
                submit="Use the standard fee"
                onSubmit={(reason) =>
                  act(
                    `${base}/fee`,
                    { feeBps: null, reason },
                    'The standard 10% applies to new tips.',
                  )
                }
              />
            )}
            <ValueWithReason
              label="Fee-free tips to grant"
              hint="Whole number, 1 to 100. Each paid tip uses one."
              submit="Grant fee-free tips"
              parse={(raw) =>
                /^\d{1,3}$/.test(raw.trim()) &&
                Number(raw) >= 1 &&
                Number(raw) <= 100
                  ? Number(raw)
                  : null
              }
              onSubmit={(count, reason) =>
                act(
                  `${base}/fee-free`,
                  { count, reason },
                  `${count} fee-free ${count === 1 ? 'tip' : 'tips'} granted.`,
                )
              }
            />
          </>
        ) : (
          <p className="tm-hint">Your role can’t change pricing.</p>
        )}
      </Card>

      {can(access, 'pages.suspend') && (
        <Card className="settings-section">
          <h2>Page</h2>
          {account.avatarPath && (
            <div className="settings-photo__row">
              {/* eslint-disable-next-line @next/next/no-img-element -- staff review the stored photo as is */}
              <img
                className="settings-photo__preview"
                src={account.avatarPath}
                alt={`Photo on @${account.handle}’s page`}
                width={96}
                height={120}
              />
              <ReasonAction
                open="Remove photo"
                field="Why remove this photo? (for example, it shows someone else)"
                submit="Remove photo"
                onSubmit={(reason) =>
                  act(
                    `${base}/avatar/remove`,
                    { reason },
                    'The photo is removed; the page shows initials.',
                  )
                }
              />
            </div>
          )}
          <ReasonAction
            open={
              account.status === 'suspended' ? 'Restore page' : 'Pause page'
            }
            field={
              account.status === 'suspended'
                ? 'Why restore this page?'
                : 'Why pause this page? The recipient sees this.'
            }
            submit={
              account.status === 'suspended' ? 'Restore page' : 'Pause page'
            }
            hint={
              account.status === 'suspended'
                ? 'Recorded in the audit log with your name and the time.'
                : 'Shown to the recipient on their dashboard, and recorded in the audit log.'
            }
            onSubmit={(reason) =>
              act(
                `${base}/${account.status === 'suspended' ? 'unsuspend' : 'suspend'}`,
                { reason },
                account.status === 'suspended'
                  ? 'The page is restored.'
                  : 'The page is paused. The recipient sees your reason.',
              )
            }
          />
        </Card>
      )}

      <Card className="settings-section">
        <h2>Recent tips</h2>
        {tips === null ? (
          <Skeleton label="Loading tips" />
        ) : tips.length === 0 ? (
          <p>No tips yet.</p>
        ) : (
          <ul className="activity-list">
            {tips.map((tip) => (
              <li key={tip.tipId}>
                <div className="activity-list__row">
                  <span>
                    Tip from {tip.supporterLabel ?? 'a guest'}
                    <small>{when(tip.at)}</small>
                  </span>
                  <span className="activity-list__amount">
                    {naira(tip.grossMinor)} → {naira(tip.netMinor)}
                    <span className={`status-tag status-tag--${tip.state}`}>
                      {tip.state}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
