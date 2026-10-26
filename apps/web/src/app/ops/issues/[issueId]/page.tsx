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
