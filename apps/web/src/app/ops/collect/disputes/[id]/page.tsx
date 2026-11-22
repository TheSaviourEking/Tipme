'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  OPS_COLLECT_EVIDENCE_MAX_BYTES,
  OPS_COLLECT_EVIDENCE_TYPES,
  type OpsCollectDisputeDetail,
} from '@tipme/contracts';
import { Button, Card, Skeleton, Slip, TextareaField } from '@tipme/ui';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import { CollectAct } from '@/components/ops/collect-act';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { Money } from '@/components/money';
import {
  DISPUTE_STATUS_WORDS,
  EVIDENCE_WORDS,
  fileWords,
} from '@/lib/collect-ops-words';
import { refusalWords } from '@/lib/ops-answers';
import { can, useOpsAccess, when } from '@/lib/ops-client';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

/**
 * One dispute (spec §9): its deadline, what is held, and the evidence state from TipMe's own records
 * (Task 5 note: never "submitted" just because the dispute ended). Evidence is files plus words,
 * submitted once with a second person, and refused after the deadline. A dispute closed without a
 * ruling can have its hold released early (P28) when no refund uses it.
 */
export default function CollectDisputePage() {
  const { id } = useParams<{ id: string }>();
  const access = useOpsAccess();
  const manage = can(access, 'collect.manage');
  const [state, setState] = useState<OpsCollectDisputeDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const result = await opsFetch<OpsCollectDisputeDetail>(
      `/v1/ops/collect/disputes/${id}`,
    );
    setFailed(!result.ok);
    if (result.ok) setState(result.data);
  }, [id]);
  useEffect(() => {
    void opsFetch<OpsCollectDisputeDetail>(
      `/v1/ops/collect/disputes/${id}`,
    ).then((result) => {
      setFailed(!result.ok);
      if (result.ok) setState(result.data);
    });
  }, [id]);

  if (failed)
    return (
      <section className="dashboard-section ops-page-body">
        <h1>Dispute</h1>
        <LoadFailed dense title="Couldn’t load the dispute" onRetry={load}>
          It may not exist, your role may not include it, or the connection
          failed.
        </LoadFailed>
      </section>
    );
  if (!state)
    return (
      <section className="dashboard-section ops-page-body">
        <h1>Dispute</h1>
        <Skeleton label="Loading the dispute" />
      </section>
    );
  const { evidence } = state;
  return (
    <section className="dashboard-section ops-page-body">
      <h1>
        Dispute on a tip to {state.handle ? `@${state.handle}` : 'a page'}
      </h1>
      <Card className="settings-section">
        <dl className="ops-facts" data-testid="dispute-facts">
          <div>
            <dt>Status</dt>
            <dd>{DISPUTE_STATUS_WORDS[state.status] ?? state.status}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>
              <Money minor={state.amountMinor} />
            </dd>
          </div>
          <div>
            <dt>Answer by</dt>
            <dd>
              {state.respondBy
                ? `${when(state.respondBy)}${evidence.late ? ' (passed)' : ''}`
                : 'No deadline given'}
            </dd>
          </div>
          <div>
            <dt>Held</dt>
            <dd>
              <Money minor={state.heldMinor} />
              {state.shareStep === 'held' ? ' (its share, never sent)' : ''}
            </dd>
          </div>
          <div>
            <dt>Evidence</dt>
            <dd data-testid="evidence-state">
              {EVIDENCE_WORDS[evidence.state]}
              {evidence.submittedAt ? `, ${when(evidence.submittedAt)}` : ''}
            </dd>
          </div>
          <div>
            <dt>Partner’s reference</dt>
            <dd className="ops-mono">{state.partnerDisputeId}</dd>
          </div>
          {state.reason && (
            <div>
              <dt>Reason code</dt>
              <dd className="ops-mono">{state.reason}</dd>
            </div>
          )}
        </dl>
      </Card>
      {manage && evidence.canSubmit && (
        <Evidence dispute={state} onChange={load} />
      )}
      {manage && evidence.late && state.status === 'open' && (
        <Slip dense tone="neutral" title="The deadline has passed">
          Evidence can’t be sent any more.
        </Slip>
      )}
      {manage && state.holdRelease.possible && (
        <Card className="settings-section">
          <h2>Release the hold</h2>
          <p className="tm-hint">
            This dispute closed without a ruling, and no refund of the tip uses
            its hold. Without this it is released 14 days after it closed.
          </p>
          <CollectAct
            path={`/v1/ops/collect/disputes/${state.id}/release-hold`}
            open="Release the hold…"
            field="Why release it now?"
            submit="Ask to release"
            done="Released: the money goes on to the recipient."
            meanwhile="The hold stays."
            onDone={load}
          />
        </Card>
      )}
      {manage &&
        !state.holdRelease.possible &&
        state.status === 'closed' &&
        !state.settledAt &&
        state.holdRelease.why && (
          <Slip dense tone="neutral" title="The hold can’t be released yet">
            {state.holdRelease.why}
          </Slip>
        )}
    </section>
  );
}

const ACCEPT = OPS_COLLECT_EVIDENCE_TYPES.join(',');

function Evidence({
  dispute,
  onChange,
}: {
  dispute: OpsCollectDisputeDetail;
  onChange: () => Promise<void>;
}) {
  const id = useId();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const { files, maxFiles } = dispute.evidence;
  // Fix round 1 (C1): the provider's own limit (one file at Bachs, five elsewhere).
  const full = files.length >= maxFiles;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!(OPS_COLLECT_EVIDENCE_TYPES as readonly string[]).includes(file.type))
      return setError('Choose a PDF, PNG or JPEG file.');
    if (file.size > OPS_COLLECT_EVIDENCE_MAX_BYTES)
      return setError('Each file can be 5 MB at most.');
    setBusy(true);
    setError('');
    const answer = await opsAct(
      `/v1/ops/collect/disputes/${dispute.id}/evidence/files`,
      { method: 'POST', file },
    );
    setBusy(false);
    if (answer.kind === 'refused') return setError(refusalWords(answer));
    await onChange();
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = String(data.get('text') ?? '').trim();
    const reason = String(data.get('reason') ?? '').trim();
    if (text.length < 20)
      return setError(
        'Write the evidence for the partner: at least 20 characters.',
      );
    if (reason.length < 10)
      return setError('Please write a reason of at least 10 characters.');
    setBusy(true);
    setError('');
    const answer = await opsAct(
      `/v1/ops/collect/disputes/${dispute.id}/evidence`,
      {
        method: 'POST',
        body: { text, reason },
      },
    );
    setBusy(false);
    if (answer.kind === 'refused') return setError(refusalWords(answer));
    setOutcome(
      outcomeOf(
        answer,
        'Approved: the evidence is being submitted to the payment partner, once.',
        'Nothing is submitted yet.',
      ),
    );
    await onChange();
  };

  if (outcome) return <ActionOutcome outcome={outcome} />;
  return (
    <Card className="settings-section">
      <h2>Evidence</h2>
      <p className="tm-hint">
        {maxFiles === 1
          ? 'Up to 1 file (PDF, PNG or JPEG, 5 MB)'
          : `Up to ${maxFiles} files (PDF, PNG or JPEG, 5 MB each)`}{' '}
        and your words for the payment partner. It is submitted once, after a
        second person approves, and can’t be changed after. A wrong file can be
        removed before then.
      </p>
      {files.length > 0 && (
        <ol className="ops-list" aria-label="Evidence files">
          {files.map((file, index) => (
            <li key={`${index}-${file.bytes}`} data-testid="evidence-file">
              File {index + 1}: {fileWords(file.contentType, file.bytes)}
              <CollectAct
                path={`/v1/ops/collect/disputes/${dispute.id}/evidence/files/${index}/remove`}
                open="Remove file…"
                field="Why remove this file?"
                submit="Remove it"
                done="Removed. You can add the right file now."
                variant="quiet"
                onDone={onChange}
              />
            </li>
          ))}
        </ol>
      )}
      {!full && (
        <div className="tm-field">
          <label htmlFor={`${id}-file`}>Add a file</label>
          <input
            id={`${id}-file`}
            type="file"
            accept={ACCEPT}
            disabled={busy}
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      )}
      <form className="ops-reason" onSubmit={(e) => void send(e)} noValidate>
        <TextareaField
          id={`${id}-text`}
          name="text"
          label="Evidence for the payment partner"
          hint="What happened, from TipMe’s records. Never paste the supporter’s details."
          maxLength={5000}
        />
        <TextareaField
          id={`${id}-reason`}
          name="reason"
          label="Reason for sending it"
          hint="Recorded in the audit log with your name and the time."
          maxLength={500}
        />
        {error && (
          <Slip dense tone="error" title="Not done">
            {error}
          </Slip>
        )}
        <Button
          variant="continue"
          type="submit"
          disabled={busy}
          aria-busy={busy}
        >
          Ask to submit
        </Button>
      </form>
    </Card>
  );
}
