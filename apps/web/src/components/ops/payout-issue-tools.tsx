'use client';
import { useId, useState, type FormEvent } from 'react';
import type {
  OpsPayoutActionResult,
  OpsPayoutIssueView,
} from '@tipme/contracts';
import { Button, Notice, TextareaField } from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import { apiFetch } from '@/lib/session-client';

const READ: Record<OpsPayoutIssueView['read']['state'], string> = {
  paid: 'The provider says this payout was paid.',
  failed: 'The provider says this payout failed.',
  pending: 'The provider has this payout and it hasn’t finished.',
  review: 'The provider has this payout and is reviewing it.',
  absent: 'The provider has no payout with TipMe’s reference.',
  uncertain:
    'The provider gave no usable answer, so nothing can be concluded from it. Try again later, and check its dashboard.',
  ambiguous:
    'The provider has more than one payout with TipMe’s reference. The recipient may have been paid twice.',
  conflicting:
    'The provider’s lookup finds a different payout from the one TipMe recorded. The recipient may have been paid twice.',
};

const DONE: Record<
  'applied' | 'resumed' | 'marked_failed',
  (reported?: string) => string
> = {
  applied: (reported) =>
    `The provider’s answer (${reported}) was recorded through the usual steps.`,
  resumed: () =>
    'The start was queued again. This issue closes once the provider has it.',
  marked_failed: () =>
    'The withdrawal is marked failed and its money is available to the recipient again.',
};

const REFUSED = {
  mismatch:
    'The provider’s record differs from what TipMe asked for, so nothing was recorded. A conflict issue says what differs.',
  not_offered:
    'The provider’s answer or the payout changed, so that is no longer allowed. Nothing was done; see what it says now.',
  not_open: 'This issue was already resolved. Nothing was done.',
} as const;

// A failed call may still have done its work, so only asking again can say.
const failed = (code: string) =>
  code === 'FORBIDDEN'
    ? 'Your role does not allow this.'
    : 'We got no clear answer. Ask the provider again to see what happened.';

/** Asks the provider first; only what that answer allows is then offered. */
export function PayoutIssueTools({
  issueId,
  onChanged,
}: {
  issueId: string;
  onChanged: (message: string) => void;
}) {
  const [view, setView] = useState<OpsPayoutIssueView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/v1/ops/issues/${issueId}`;

  const ask = async () => {
    setBusy(true);
    setError('');
    const result = await apiFetch<OpsPayoutIssueView>(`${base}/payout-read`, {
      method: 'POST',
      body: {},
    });
    setBusy(false);
    if (result.ok) setView(result.data);
    else setError(failed(result.code));
  };

  const act = async (
    path: string,
    body: unknown,
    reported?: string,
  ): Promise<string | null> => {
    const result = await apiFetch<OpsPayoutActionResult>(`${base}/${path}`, {
      method: 'POST',
      body,
    });
    if (!result.ok) return failed(result.code);
    setView(result.data.view);
    const { outcome } = result.data;
    if (
      outcome === 'mismatch' ||
      outcome === 'not_offered' ||
      outcome === 'not_open'
    )
      return REFUSED[outcome];
    onChanged(DONE[outcome](reported));
    return null;
  };

  return (
    <>
      <p>
        Every action here asks the provider again first. None sends a payout
        that was already tried, and none edits the ledger.
      </p>
      <Button
        variant="secondary"
        onClick={() => void ask()}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? 'Asking the provider…' : 'Ask the provider'}
      </Button>
      {error && (
        <Notice tone="error" title="Check what happened">
          {error}
        </Notice>
      )}
      {view && <Answer view={view} act={act} />}
    </>
  );
}

function Answer({
  view,
  act,
}: {
  view: OpsPayoutIssueView;
  act: (
    path: string,
    body: unknown,
    reported?: string,
  ) => Promise<string | null>;
}) {
  const { read, offers } = view;
  const none = !offers.applyReported && !offers.resume && !offers.markFailed;
  return (
    <div className="ops-recovery">
      <p role="status">
        <strong>{READ[read.state]}</strong>
        {read.referenceTail && ` Its reference ends …${read.referenceTail}.`}
        {read.failureReason && ` Reason: ${read.failureReason}.`}
      </p>
      {read.differing.length > 0 && (
        <Notice tone="error" title="It differs from what TipMe asked for">
          Different: {read.differing.join(', ')}. Nothing can be recorded from
          it.
        </Notice>
      )}
      {view.holdActive && (
        <p className="tm-hint">Withdrawals for this recipient are on hold.</p>
      )}
      {view.parkedEvent && (
        <p className="tm-hint">
          A signed event from the provider names this payout, so “the provider
          has none” isn’t believed.
        </p>
      )}
      {view.openConflict && (
        <p className="tm-hint">Another conflict about this payout is open.</p>
      )}
      {view.startStep === 'payout' && (
        <p className="tm-hint">
          The payout call was attempted, so this can’t be released here. Ask the
          provider’s support about the reference.
        </p>
      )}
      {none && <p className="tm-hint">Nothing can be done from this answer.</p>}
      <div className="ops-actions">
        {offers.applyReported && (
          <ReasonAction
            errorTitle="Check what happened"
            open={`Record it as ${offers.applyReported}…`}
            field="Why record this now?"
            submit={`Record as ${offers.applyReported}`}
            onSubmit={(reason) =>
              act(
                'payout-apply',
                { reason, reported: offers.applyReported },
                offers.applyReported ?? undefined,
              )
            }
          />
        )}
        {offers.resume && (
          <ReasonAction
            errorTitle="Check what happened"
            open="Resume this withdrawal…"
            field="Why resume it?"
            hint={
              view.destinationReplaced
                ? 'The recipient has changed their bank since asking; it still goes to the bank recorded with the withdrawal. Recorded in the audit log.'
                : 'No create was ever tried. Recorded in the audit log with your name and the time.'
            }
            submit="Resume withdrawal"
            onSubmit={(reason) => act('payout-resume', { reason })}
          />
        )}
      </div>
      {offers.markFailed && (
        <MarkFailed
          step={view.startStep}
          onSubmit={(reason) =>
            act('payout-mark-failed', { reason, dashboardVerified: true })
          }
        />
      )}
    </div>
  );
}

function MarkFailed({
  step,
  onSubmit,
}: {
  step: OpsPayoutIssueView['startStep'];
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
    if (reason.length < 10 || data.get('dashboardVerified') !== 'on') {
      setError('Write a reason of at least 10 characters and tick the box.');
      return;
    }
    setBusy(true);
    setError('');
    const problem = await onSubmit(reason);
    setBusy(false);
    if (problem) setError(problem);
  };
  return (
    <form
      className="settings-form ops-recovery"
      onSubmit={(e) => void submit(e)}
    >
      <h3>Mark failed and release the money</h3>
      <p>
        {step === 'fee'
          ? 'The last step tried was the fee top-up, so the payout itself was not sent. The top-up may have gone through: check for it.'
          : 'No payout call was recorded as attempted.'}{' '}
        The money becomes available to the recipient again.
      </p>
      <TextareaField
        id={`${id}-reason`}
        name="reason"
        label="What did you find at the provider?"
        hint="Recorded in the audit log with your name and the time."
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
          I checked the provider’s dashboard, and this payout is not there.
        </span>
      </label>
      {error && (
        <Notice tone="error" title="Check what happened">
          {error}
        </Notice>
      )}
      <Button type="submit" disabled={busy} aria-busy={busy}>
        Mark failed and release
      </Button>
    </form>
  );
}
