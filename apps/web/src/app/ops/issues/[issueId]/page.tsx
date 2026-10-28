'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type {
  OpsIssueEvidence,
  OpsPrivateDetails,
  OpsRecheckOutcome,
} from '@tipme/contracts';
import {
  Badge,
  Button,
  Card,
  Notice,
  Skeleton,
  TextareaField,
} from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import { naira } from '@/lib/money';
import {
  can,
  ISSUE_KIND_LABELS,
  SEVERITY_LABELS,
  useOpsAccess,
  when,
} from '@/lib/ops-client';
import { apiFetch } from '@/lib/session-client';

// Bachs IDs are opaque (no fixed prefix); whitespace, ':' and '/' are refused. The browser
// compiles this with the `v` flag, so '/' is escaped.
const BACHS_ID_PATTERN = String.raw`[^\s:\/]{1,200}`;

type Evidence = OpsIssueEvidence & { traceUrl: string | null };

const RECHECK: Record<OpsRecheckOutcome, string> = {
  applied: 'The provider gave a final answer and it was recorded.',
  unchanged: 'The provider has no final answer yet. Nothing changed.',
  unresolved: 'The provider has no record of this payment.',
  error: 'The provider could not be reached. Try again later.',
  not_pending: 'Nothing to re-check: it is no longer waiting on the provider.',
};

const failure = (code: string) =>
  code === 'ISSUE_RESOLVED'
    ? 'This issue was already resolved.'
    : code === 'FORBIDDEN'
      ? 'Your role does not allow this.'
      : 'That didn’t work. Please try again.';

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <Card className="settings-section ops-section">
      <section aria-labelledby={id}>
        <h2 id={id}>{title}</h2>
        {children}
      </section>
    </Card>
  );
}

const REPORT_LABELS = {
  impersonation: 'Pretending to be someone else',
  scam: 'Scam or fraud',
  abusive: 'Abusive or hateful',
  other: 'Something else',
} as const;

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="ops-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

function NoteForm({ onSave }: { onSave: (text: string) => Promise<boolean> }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const text = String(new FormData(form).get('text') ?? '').trim();
    if (!text) return;
    setBusy(true);
    if (await onSave(text)) form.reset();
    setBusy(false);
  };
  return (
    <form className="settings-form" onSubmit={(e) => void submit(e)}>
      <TextareaField
        id={`${id}-note`}
        name="text"
        label="Add a note"
        maxLength={2000}
        required
      />
      <Button type="submit" variant="secondary" disabled={busy}>
        Save note
      </Button>
    </form>
  );
}

type RecoveryResult = {
  outcome:
    | 'attached'
    | 'pending'
    | 'not_found'
    | 'mismatch'
    | 'not_pending'
    | 'recovered';
  status?: 'ACTIVE' | 'ONBOARDING' | 'RESTRICTED';
};

function BachsRecoveryAction({
  valueLabel,
  valueName,
  pattern,
  hint,
  confirmation,
  submitLabel,
  onSubmit,
}: {
  valueLabel: string;
  valueName: string;
  pattern: string;
  hint: string;
  confirmation: string;
  submitLabel: string;
  onSubmit: (value: string, reason: string) => Promise<string | null>;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = String(data.get(valueName) ?? '').trim();
    const reason = String(data.get('reason') ?? '').trim();
    if (!value || reason.length < 10 || data.get('dashboardVerified') !== 'on')
      return;
    setBusy(true);
    setError('');
    const problem = await onSubmit(value, reason);
    setBusy(false);
    if (problem) setError(problem);
    else form.reset();
  };
  return (
    <form
      className="settings-form ops-recovery"
      onSubmit={(e) => void submit(e)}
    >
      <div className="tm-field">
        <label htmlFor={`${id}-value`}>{valueLabel}</label>
        <input
          id={`${id}-value`}
          className="tm-input"
          name={valueName}
          autoComplete="off"
          pattern={pattern}
          maxLength={70}
          required
        />
        <span className="tm-hint">{hint}</span>
      </div>
      <TextareaField
        id={`${id}-reason`}
        name="reason"
        label="Why are you recovering this provider record?"
        hint="Recorded in the audit log with your name and time."
        minLength={10}
        maxLength={500}
        required
      />
      <label className="ops-recovery__confirm" htmlFor={`${id}-verified`}>
        <input
          id={`${id}-verified`}
          name="dashboardVerified"
          type="checkbox"
          required
        />
        <span>{confirmation}</span>
      </label>
      {error && (
        <Notice tone="error" title="Recovery not completed">
          {error}
        </Notice>
      )}
      <Button type="submit" disabled={busy} aria-busy={busy}>
        {busy ? 'Checking with Bachs…' : submitLabel}
      </Button>
    </form>
  );
}

type FeeBearerResult = {
  outcome:
    | 'confirmed'
    | 'not_pending'
    | 'not_collected'
    | 'mismatch'
    | 'recipient_bore_fee';
};

const FEE_BEARER: Record<FeeBearerResult['outcome'], string> = {
  confirmed:
    'Bachs’ payment matched the quote. With the fee confirmed as paid by the platform, the tip is now paid.',
  not_pending: 'This tip already has a final outcome. Nothing changed.',
  not_collected:
    'Bachs has not taken this payment (or TipMe never saw it taken). Nothing changed.',
  mismatch:
    'Bachs reports a different amount, currency or TipMe fee than the quote. Nothing changed; look into it in Bachs.',
  recipient_bore_fee:
    'Bachs says the recipient paid the processing fee. That cannot be overridden here. Nothing changed.',
};

/** Confirms one fact Bachs left out (the platform paid the fee); TipMe re-reads the rest. */
function BachsFeeBearerAction({
  onSubmit,
}: {
  onSubmit: (reason: string) => Promise<string | null>;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const reason = String(data.get('reason') ?? '').trim();
    if (reason.length < 10 || data.get('dashboardVerified') !== 'on') return;
    setBusy(true);
    setError('');
    const problem = await onSubmit(reason);
    setBusy(false);
    if (problem) setError(problem);
    else form.reset();
  };
  return (
    <form
      className="settings-form ops-recovery"
      onSubmit={(e) => void submit(e)}
    >
      <TextareaField
        id={`${id}-reason`}
        name="reason"
        label="What did you see in Bachs Dashboard?"
        hint="Recorded in the audit log with your name and time."
        minLength={10}
        maxLength={500}
        required
      />
      <label className="ops-recovery__confirm" htmlFor={`${id}-verified`}>
        <input
          id={`${id}-verified`}
          name="dashboardVerified"
          type="checkbox"
          required
        />
        <span>
          I found this payment in Bachs Dashboard, and it shows the processing
          fee was paid by the platform.
        </span>
      </label>
      {error && (
        <Notice tone="error" title="Not confirmed">
          {error}
        </Notice>
      )}
      <Button type="submit" disabled={busy} aria-busy={busy}>
        {busy ? 'Checking with Bachs…' : 'Confirm the fee and check the tip'}
      </Button>
    </form>
  );
}

/** One issue with every data point needed to resolve it or decide, and the actions allowed. */
export default function IssuePage() {
  const { issueId } = useParams<{ issueId: string }>();
  const access = useOpsAccess();
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [missing, setMissing] = useState(false);
  const [revealed, setRevealed] = useState<OpsPrivateDetails | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(
    () =>
      apiFetch<Evidence>(`/v1/ops/issues/${encodeURIComponent(issueId)}`).then(
        (result) => {
          if (result.ok) setEvidence(result.data);
          else setMissing(true);
        },
      ),
    [issueId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (path: string, body: unknown, done: string) => {
    const result = await apiFetch(path, { method: 'POST', body });
    if (!result.ok) return failure(result.code);
    setMessage(done);
    await load();
    return null;
  };

  if (missing)
    return (
      <Notice tone="error" title="We couldn’t find that issue">
        <Link href="/ops/issues">Back to issues</Link>
      </Notice>
    );
  if (!evidence) return <Skeleton label="Loading the issue" />;

  const { issue, page, person, tipProof, payout } = evidence;
  const open = issue.status === 'open';
  const hasPrivate = Object.values(evidence.private).some(Boolean);
  const recheckTarget = issue.subject.attemptId
    ? { attemptId: issue.subject.attemptId }
    : payout && ['REQUESTED', 'PROCESSING'].includes(payout.status)
      ? { payoutId: payout.id }
      : evidence.attempts.at(-1)
        ? { attemptId: evidence.attempts.at(-1)!.id }
        : null;
  const recoveryPending =
    evidence.recovery &&
    !evidence.recovery.cancelledAt &&
    !evidence.recovery.completedAt;

  return (
    <div className="ops-issue">
      <p>
        <Link href="/ops/issues">← All issues</Link>
      </p>
      <h1>{ISSUE_KIND_LABELS[issue.kind] ?? issue.kind}</h1>
      <p className="ops-issue__status">
        <Badge className={`ops-severity ops-severity--${issue.severity}`}>
          {SEVERITY_LABELS[issue.severity]}
        </Badge>{' '}
        <Badge>{open ? 'Open' : 'Resolved'}</Badge>{' '}
        <span className="tm-hint">
          Opened {when(issue.openedAt)}
          {issue.resolvedAt &&
            ` · resolved ${when(issue.resolvedAt)} by ${
              issue.resolvedBy === 'system' ? 'the system' : 'staff'
            }`}
        </span>
      </p>
      <p className="ops-summary">{issue.summary}</p>
      {message && (
        <Notice tone="success" title="Done">
          {message}
        </Notice>
      )}

      <Section title="Decide">
        <div className="ops-actions">
          {open && can(access, 'issues.resolve') && (
            <ReasonAction
              open="Resolve…"
              variant="primary"
              field="How was it resolved?"
              submit="Resolve issue"
              onSubmit={(reason) =>
                act(
                  `/v1/ops/issues/${issue.id}/resolve`,
                  { reason },
                  'The issue is resolved.',
                )
              }
            />
          )}
          {recheckTarget && can(access, 'payments.recheck') && (
            <ReasonAction
              open="Re-check with the provider…"
              field="Why re-check now?"
              submit="Ask the provider"
              onSubmit={async (reason) => {
                const result = await apiFetch<{ outcome: OpsRecheckOutcome }>(
                  '/v1/ops/recheck',
                  { method: 'POST', body: { ...recheckTarget, reason } },
                );
                if (!result.ok) return failure(result.code);
                setMessage(RECHECK[result.data.outcome]);
                await load();
                return null;
              }}
            />
          )}
          {page && can(access, 'pages.suspend') && (
            <ReasonAction
              open={
                page.status === 'suspended'
                  ? 'Restore this page…'
                  : 'Pause this page…'
              }
              field={
                page.status === 'suspended'
                  ? 'Why restore it?'
                  : 'Message to the recipient'
              }
              hint={
                page.status === 'suspended'
                  ? undefined
                  : 'The recipient sees this message exactly as written on their dashboard. Don’t include supporters’ names, numbers or who reported the page. Also recorded in the audit log.'
              }
              submit={
                page.status === 'suspended' ? 'Restore page' : 'Pause page'
              }
              onSubmit={(reason) =>
                act(
                  `/v1/ops/pages/${page.profileId}/${
                    page.status === 'suspended' ? 'unsuspend' : 'suspend'
                  }`,
                  { reason },
                  page.status === 'suspended'
                    ? 'The page is restored.'
                    : 'The page is paused. The recipient sees your reason.',
                )
              }
            />
          )}
          {recoveryPending && person && can(access, 'recoveries.cancel') && (
            <ReasonAction
              open="Cancel the phone recovery…"
              field="Why cancel it?"
              submit="Cancel recovery"
              onSubmit={(reason) =>
                act(
                  `/v1/ops/users/${person.userId}/cancel-recovery`,
                  { reason },
                  'The recovery is cancelled.',
                )
              }
            />
          )}
        </div>
        <p className="tm-hint">
          Admin actions never move money: no refunds, adjustments or payout
          holds.
        </p>
      </Section>

      {open &&
        issue.kind === 'stuck_tip' &&
        issue.subject.tipId &&
        can(access, 'payments.recheck') && (
          <Section title="Bachs took the money but not the fee details">
            <p>
              Use this only when Bachs shows the payment succeeded but never
              said who paid its processing fee. You confirm that one fact; TipMe
              then reads the payment from Bachs again and marks the tip paid
              only if the amount, currency and TipMe fee match the quote. If
              Bachs says the recipient paid the fee, nothing changes.
            </p>
            <BachsFeeBearerAction
              onSubmit={async (reason) => {
                const result = await apiFetch<FeeBearerResult>(
                  '/v1/ops/bachs/fee-bearer-confirmation',
                  {
                    method: 'POST',
                    body: {
                      issueId: issue.id,
                      feePaidBy: 'platform',
                      dashboardVerified: true,
                      reason,
                    },
                  },
                );
                if (!result.ok) return failure(result.code);
                setMessage(FEE_BEARER[result.data.outcome]);
                await load();
                return null;
              }}
            />
          </Section>
        )}

      {open &&
        issue.kind === 'payment_attempt_unresolved' &&
        issue.subject.attemptId &&
        can(access, 'payments.recheck') && (
          <Section title="Recover an unknown Bachs checkout">
            <p>
              Enter a checkout ID you found in Bachs Dashboard. TipMe checks it
              against the expected amount and currency before linking it. If it
              is missing or mismatched, the payment stays unknown. This never
              marks a payment as paid manually.
            </p>
            <BachsRecoveryAction
              valueLabel="Bachs checkout ID"
              valueName="checkoutId"
              pattern={BACHS_ID_PATTERN}
              hint="The ID must be from Bachs Dashboard, not a URL or payment reference."
              confirmation="I found this checkout in Bachs Dashboard and checked that it belongs to this TipMe payment."
              submitLabel="Verify and recover checkout"
              onSubmit={async (checkoutId, reason) => {
                const result = await apiFetch<RecoveryResult>(
                  '/v1/ops/bachs/checkout-recovery',
                  {
                    method: 'POST',
                    body: {
                      issueId: issue.id,
                      attemptId: issue.subject.attemptId,
                      checkoutId,
                      dashboardVerified: true,
                      reason,
                    },
                  },
                );
                if (!result.ok) return failure(result.code);
                const status = result.data.outcome;
                setMessage(
                  status === 'attached'
                    ? 'The checkout was verified and linked. TipMe applied only the provider-verified result.'
                    : status === 'pending'
                      ? 'The checkout exists and its amount and currency match, but its outcome is still pending. Nothing was marked paid.'
                      : status === 'not_found'
                        ? 'Bachs could not find this checkout. The attempt remains unknown and unlinked.'
                        : status === 'mismatch'
                          ? 'The checkout amount or currency did not match. It remains unlinked and the attempt remains unknown.'
                          : 'This attempt is no longer waiting for checkout recovery.',
                );
                await load();
                return null;
              }}
            />
          </Section>
        )}

      {open &&
        issue.kind === 'payment_account_unresolved' &&
        issue.subject.profileId &&
        can(access, 'payments.recheck') && (
          <Section title="Recover an unknown Bachs recipient account">
            <p>
              TipMe fetches the account status from Bachs before linking it.
              Payouts remain disabled. The issue resolves only after the account
              ID and current provider status are verified.
            </p>
            {!person?.emailVerified ? (
              <Notice tone="error" title="Recipient email is not verified">
                Do not link an account until the recipient has a verified TipMe
                email address.
              </Notice>
            ) : (
              <BachsRecoveryAction
                valueLabel="Bachs account ID"
                valueName="accountReference"
                pattern={BACHS_ID_PATTERN}
                hint="Use the account ID shown in Bachs Dashboard."
                confirmation="I confirmed in Bachs Dashboard that this account belongs to the recipient’s verified TipMe email and that platform fees are configured correctly."
                submitLabel="Verify and recover account"
                onSubmit={async (accountReference, reason) => {
                  const result = await apiFetch<RecoveryResult>(
                    '/v1/ops/bachs/account-recovery',
                    {
                      method: 'POST',
                      body: {
                        issueId: issue.id,
                        accountReference,
                        dashboardVerified: true,
                        reason,
                      },
                    },
                  );
                  if (!result.ok) return failure(result.code);
                  const status = result.data.outcome;
                  setMessage(
                    status === 'recovered'
                      ? `The account status was fetched and linked (${result.data.status}). The issue is resolved; payouts remain disabled.`
                      : status === 'not_found'
                        ? 'Bachs could not find this account. No mapping was stored and the issue remains open.'
                        : status === 'mismatch'
                          ? 'Bachs returned a different account ID. No mapping was stored and the issue remains open.'
                          : 'This account setup is no longer waiting for recovery.',
                  );
                  await load();
                  return null;
                }}
              />
            )}
          </Section>
        )}

      {page && (
        <Section title="Page">
          <Facts
            rows={[
              [
                'Page',
                <a key="page" href={`/@${page.handle}`}>
                  @{page.handle}
                </a>,
              ],
              [
                'Plan and pricing',
                <Link
                  key="pricing"
                  href={`/ops/pages?handle=${encodeURIComponent(page.handle)}`}
                >
                  Open the page’s plan and pricing
                </Link>,
              ],
              [
                'State',
                page.status === 'suspended'
                  ? 'Paused by TipMe'
                  : page.pageState === 'live'
                    ? 'Live'
                    : page.pageState === 'deleted'
                      ? 'Deleted'
                      : 'Not live',
              ],
              ...(page.suspendedReason
                ? ([['Pause reason', page.suspendedReason]] as [
                    string,
                    React.ReactNode,
                  ][])
                : []),
              // Visitors' reports since this issue opened (PR-013): reasons and counts only.
              ...(evidence.pageReports && evidence.pageReports.length > 0
                ? ([
                    [
                      'Reports',
                      evidence.pageReports
                        .map((r) => `${REPORT_LABELS[r.reason]} ×${r.count}`)
                        .join(' · '),
                    ],
                  ] as [string, React.ReactNode][])
                : []),
            ]}
          />
        </Section>
      )}

      {person && (
        <Section title="Person">
          <Facts
            rows={[
              ['Phone', person.phoneHint],
              [
                'Email',
                person.emailMasked
                  ? `${person.emailMasked}${person.emailVerified ? ' (verified)' : ''}`
                  : null,
              ],
              ['Account', person.deleted ? 'Deleted' : 'Active'],
            ]}
          />
        </Section>
      )}

      {hasPrivate && (
        <Section title="Private details">
          {revealed ? (
            <Facts
              rows={[
                ['Supporter’s message', revealed.message ?? null],
                ['Supporter’s name', revealed.supporterLabel ?? null],
                ['Phone', revealed.phone ?? null],
                ['Email', revealed.email ?? null],
              ]}
            />
          ) : (
            <>
              <p className="tm-hint">
                Hidden. Showing them needs a reason and is recorded.
              </p>
              {can(access, 'private.view') && (
                <ReasonAction
                  open="Reveal private details"
                  field="Why do you need to see them?"
                  submit="Reveal"
                  onSubmit={async (reason) => {
                    const result = await apiFetch<OpsPrivateDetails>(
                      `/v1/ops/issues/${issue.id}/reveal`,
                      { method: 'POST', body: { reason } },
                    );
                    if (!result.ok) return failure(result.code);
                    setRevealed(result.data);
                    return null;
                  }}
                />
              )}
            </>
          )}
        </Section>
      )}

      {tipProof && (
        <Section title="The tip">
          <Facts
            rows={[
              ['Status', tipProof.tip.status],
              ['Amount', naira(tipProof.breakdown.grossMinor)],
              // Since PR-012 processing is paid out of TipMe's 10%; this is what TipMe keeps.
              ['TipMe keeps', naira(tipProof.breakdown.platformFeeMinor)],
              ['Recipient gets', naira(tipProof.breakdown.recipientNetMinor)],
              [
                'Ledger',
                tipProof.paymentLedgerTransactionId
                  ? `Booked (${tipProof.paymentLedgerTransactionId.slice(-8)})`
                  : 'Not booked',
              ],
            ]}
          />
          <h3>History</h3>
          <ol className="ops-timeline">
            {tipProof.history.map((step, index) => (
              <li key={`${step.at}-${index}`}>
                <strong>
                  {step.entityType}: {step.fromStatus ?? 'new'} →{' '}
                  {step.toStatus}
                </strong>{' '}
                <span className="tm-hint">
                  {step.cause} · {when(step.at)}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {(evidence.attempts.length > 0 || evidence.providerEvents.length > 0) && (
        <Section title="Payment provider">
          {evidence.attempts.map((attempt) => (
            <Facts
              key={attempt.id}
              rows={[
                ['Attempt', attempt.status],
                [
                  'Reference',
                  attempt.referenceTail ? `…${attempt.referenceTail}` : null,
                ],
                [
                  'Last asked',
                  attempt.lastReconciledAt
                    ? when(attempt.lastReconciledAt)
                    : 'Never',
                ],
              ]}
            />
          ))}
          <h3>Events from the provider</h3>
          <ol className="ops-timeline">
            {evidence.providerEvents.map((event) => (
              <li key={event.id}>
                <strong>{event.eventType}</strong>{' '}
                <span className="tm-hint">
                  {event.processingOutcome ?? 'not processed'} ·{' '}
                  {when(event.receivedAt)} · …{event.eventIdTail}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {payout && (
        <Section title="Withdrawal">
          <Facts
            rows={[
              ['Status', payout.status],
              ['Amount', naira(payout.amountMinor)],
              [
                'Reference',
                payout.referenceTail ? `…${payout.referenceTail}` : null,
              ],
              ['Requested', when(payout.createdAt)],
            ]}
          />
        </Section>
      )}

      {evidence.unmatched && (
        <Section title="Unmatched event">
          <Facts
            rows={[
              ['Event', evidence.unmatched.eventType],
              ['Why unmatched', evidence.unmatched.reason],
              ['Received', when(evidence.unmatched.receivedAt)],
            ]}
          />
        </Section>
      )}

      {evidence.recovery && (
        <Section title="Phone recovery">
          <Facts
            rows={[
              ['New number', evidence.recovery.newPhoneHint],
              ['Takes effect', when(evidence.recovery.effectiveAt)],
              [
                'Outcome',
                evidence.recovery.completedAt
                  ? 'Completed'
                  : evidence.recovery.cancelledAt
                    ? 'Cancelled'
                    : 'Waiting',
              ],
            ]}
          />
        </Section>
      )}

      <Section title="Support reference">
        <Facts
          rows={[
            [
              'Trace',
              evidence.traceId ? (
                evidence.traceUrl ? (
                  <a href={evidence.traceUrl} target="_blank" rel="noreferrer">
                    {evidence.traceId}
                  </a>
                ) : (
                  evidence.traceId
                )
              ) : null,
            ],
          ]}
        />
      </Section>

      {evidence.related.length > 0 && (
        <Section title="Related open issues">
          <ul>
            {evidence.related.map((related) => (
              <li key={related.id}>
                <Link href={`/ops/issues/${related.id}`}>
                  {ISSUE_KIND_LABELS[related.kind] ?? related.kind}
                </Link>{' '}
                <span className="tm-hint">{when(related.openedAt)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Notes">
        {evidence.notes.length === 0 ? (
          <p className="tm-hint">No notes yet.</p>
        ) : (
          <ol className="ops-timeline">
            {evidence.notes.map((note) => (
              <li key={note.id}>
                <p>{note.text}</p>
                <span className="tm-hint">{when(note.createdAt)}</span>
              </li>
            ))}
          </ol>
        )}
        <NoteForm
          onSave={async (text) => {
            const result = await apiFetch(`/v1/ops/issues/${issue.id}/notes`, {
              method: 'POST',
              body: { text },
            });
            if (result.ok) await load();
            return result.ok;
          }}
        />
      </Section>
    </div>
  );
}
