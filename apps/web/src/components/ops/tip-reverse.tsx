'use client';
import { useId, useState, type FormEvent } from 'react';
import type { OpsTipReversed } from '@tipme/contracts';
import { Button, InputField, Slip, TextareaField } from '@tipme/ui';
import { parseNaira } from '@/lib/money';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';
import { opsAct } from '@/lib/ops-staff-api';
import type { TipReverseView } from '@/lib/tip-reverse-view';
import { outcomeOf, type ActionOutcomeState } from './action-outcome';
import { Money } from '@/components/money';

/**
 * Taking back a refunded or charged-back tip from its issue (`tip.reverse`, business release 2 Q7;
 * owner 14 Nov 2026 for the fee). Says in plain words what the ledger will record before anything
 * is asked: who gives back what, that TipMe keeps its fee on a refund and bears it on a chargeback,
 * that a balance can go below zero, and that nothing moves at our payment partner. A reasoned
 * action behind "…", with the dashboard check; a second person approves when there is one.
 */
export function TipReverse({
  issueId,
  view,
  handle,
  onDone,
  onRefused,
}: {
  issueId: string;
  view: Extract<TipReverseView, { kind: 'refund' | 'dispute' }>;
  handle: string | null;
  onDone: (outcome: ActionOutcomeState) => void;
  /** The issue's notes say why a reversal was refused: read it again. */
  onRefused: () => Promise<void>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const person = handle ? `@${handle}` : 'The person tipped';
  const refund = view.kind === 'refund';

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const reason = String(data.get('reason') ?? '').trim();
    const amount = refund
      ? Number(view.refundedMinor)
      : parseNaira(String(data.get('amount') ?? '').trim());
    if (!amount)
      return setError(
        'Enter the amount charged back, in naira, as the dashboard shows it.',
      );
    if (data.get('checked') !== 'yes')
      return setError(
        'Confirm you checked this in our payment partner’s dashboard.',
      );
    if (reason.length < 10)
      return setError('Please write a reason of at least 10 characters.');
    setBusy(true);
    setError('');
    const answer = await opsAct<OpsTipReversed>(
      `/v1/ops/issues/${issueId}/reverse-tip`,
      {
        method: 'POST',
        body: {
          reason,
          refundedMinor: String(amount),
          dashboardVerified: true,
        },
      },
    );
    setBusy(false);
    if (answer.kind === 'refused') {
      if (
        outcomeIsUnknown(answer) ||
        ['TIP_NOT_REVERSIBLE', 'NOT_FOUND', 'ISSUE_RESOLVED'].includes(
          answer.code,
        )
      )
        await onRefused();
      return setError(
        answer.code === 'TIP_NOT_REVERSIBLE'
          ? 'Not taken back, and nothing was recorded. The issue’s notes say why.'
          : answer.code === 'NOT_FOUND'
            ? 'This report can’t be taken back from TipMe any more. Nothing was recorded.'
            : refusalWords(answer),
      );
    }
    setOpen(false);
    const done =
      answer.kind === 'done' && !answer.data.posted
        ? 'This refund or chargeback was already taken back. Nothing new was recorded.'
        : answer.kind === 'done' && answer.data.belowZero
          ? 'Taken back in TipMe’s books. A balance is now below zero, so its withdrawals wait until it is back above zero (a new issue says whose). Resolve this issue when you’re done.'
          : 'Taken back in TipMe’s books. Resolve this issue when you’re done.';
    onDone({
      ...outcomeOf(answer, done, 'Nothing is recorded until then.'),
      ...(answer.kind === 'done' && answer.data.belowZero
        ? { warning: true }
        : {}),
    } as ActionOutcomeState);
  };

  return (
    <div className="ops-tip-reverse" data-testid="tip-reverse">
      {refund ? (
        <p>
          Our payment partner gave the supporter back{' '}
          <strong>
            <Money code minor={view.refundedMinor} />
          </strong>
          . Taking it back records that in TipMe’s books: {person} gives back
          their part of it, and a business its share if there is one, each in
          proportion. TipMe keeps its fee on a refund. If the refund is more
          than they received, only what they received is taken back.
        </p>
      ) : (
        <p>
          A chargeback: the supporter’s bank took money back through our payment
          partner. Taking it back records that in TipMe’s books: {person} gives
          back what they received from it, and a business its share if there is
          one, each in proportion. TipMe bears its own fee.
        </p>
      )}
      <p>
        If the money was already withdrawn, the balance goes below zero and
        withdrawals wait until it is back above zero. Nothing moves at our
        payment partner: this only records what already happened there. It can’t
        be undone, and each refund or chargeback is taken back once.
      </p>
      {!open ? (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Take back this tip…
        </Button>
      ) : (
        <form
          className="ops-reason"
          onSubmit={(e) => void send(e)}
          onChange={() => setError('')}
          noValidate
        >
          {refund ? (
            <p>
              Amount:{' '}
              <strong>
                <Money code minor={view.refundedMinor} />
              </strong>
              , as our payment partner reported it.
            </p>
          ) : (
            <InputField
              id={`${id}-amount`}
              name="amount"
              className="money"
              label="Amount charged back (NGN)"
              hint="As our payment partner’s dashboard shows it. Less than the tip is a partial chargeback."
              inputMode="decimal"
              autoComplete="off"
            />
          )}
          <label className="ops-recovery__confirm" htmlFor={`${id}-checked`}>
            <input
              id={`${id}-checked`}
              type="checkbox"
              name="checked"
              value="yes"
            />
            <span>
              I checked this {refund ? 'refund' : 'chargeback'} in our payment
              partner’s dashboard.
            </span>
          </label>
          <TextareaField
            id={`${id}-reason`}
            name="reason"
            label="Why take this tip back?"
            hint="Recorded in the audit log with your name and the time. A second person approves before anything is recorded."
            maxLength={500}
          />
          {error && (
            <Slip dense tone="error" title="Not done">
              {error}
            </Slip>
          )}
          <div className="ops-actions">
            <Button
              type="submit"
              variant="continue"
              disabled={busy}
              aria-busy={busy}
            >
              Take back the tip
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setError('');
                setOpen(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
