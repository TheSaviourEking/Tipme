'use client';
import { useState } from 'react';
import type { OpsTipRefund } from '@tipme/contracts';
import { Button, Notice } from '@tipme/ui';
import { nairaCode as naira } from '@/lib/money';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';
import { ActionOutcome, type ActionOutcomeState } from './action-outcome';
import { ReasonAction } from './reason-action';

/**
 * Staff "Refund tip…" (owner, 14 Nov 2026), behind TIP_REFUNDS. Says exactly what the supporter
 * gets back (the tip minus TipMe's fee, which TipMe keeps) and who gives back what, then asks with
 * a written reason; a second person approves. Our payment partner is never named.
 */
export function TipRefund({ tipId }: { tipId: string }) {
  const [facts, setFacts] = useState<OpsTipRefund | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const path = `/v1/ops/tips/${tipId}/refund`;

  const open = async () => {
    setBusy(true);
    setProblem('');
    const result = await opsFetch<OpsTipRefund>(path);
    setBusy(false);
    if (result.ok) setFacts(result.data);
    else
      setProblem(
        result.code === 'TIP_REFUNDS_OFF'
          ? 'Tip refunds aren’t switched on.'
          : 'We couldn’t read this tip. Please try again.',
      );
  };

  const ask = async (reason: string): Promise<string | null> => {
    const answer = await opsAct<{ refundId: string; amountMinor: string }>(
      path,
      { method: 'POST', body: { reason } },
    );
    if (answer.kind === 'refused')
      return answer.code === 'TIP_REFUND_REFUSED'
        ? 'This tip can’t be refunded now. Open it again to see why.'
        : 'Not asked. Please try again.';
    setFacts(null);
    setOutcome(
      answer.kind === 'waiting'
        ? {
            kind: 'waiting',
            repeat: answer.repeat,
            meanwhile: 'Nothing is refunded until a second person approves.',
          }
        : {
            kind: 'done',
            actedAlone: answer.actedAlone,
            text: `Refund of ${naira(answer.data.amountMinor)} asked. It goes to our payment partner next, and is recorded when they confirm it.`,
          },
    );
    return null;
  };

  if (outcome) return <ActionOutcome outcome={outcome} />;
  if (!facts)
    return (
      <span className="tip-refund">
        <Button
          variant="quiet"
          onClick={() => void open()}
          disabled={busy}
          aria-busy={busy}
        >
          Refund tip…
        </Button>
        {problem && (
          <Notice tone="error" title="Not open">
            {problem}
          </Notice>
        )}
      </span>
    );
  const page = facts.handle ? `@${facts.handle}` : 'The page';
  return (
    <div className="tip-refund" data-testid="tip-refund">
      <p>
        The supporter gets back <strong>{naira(facts.refundMinor)}</strong>: the{' '}
        {naira(facts.grossMinor)} tip minus TipMe’s {naira(facts.feeMinor)} fee,
        which TipMe keeps.
      </p>
      <p>
        {facts.businessName
          ? `${page} gives back ${naira(facts.personMinor)} and ${facts.businessName} gives back ${naira(facts.businessMinor)}: what each received.`
          : `${page} gives back ${naira(facts.personMinor)}: what they received.`}
      </p>
      {facts.refundable ? (
        <ReasonAction
          open="Ask to refund"
          field="Why is this tip being refunded?"
          submit="Ask for the refund"
          hint="Recorded in the audit log with your name and the time. A second person approves before anything is refunded."
          onSubmit={ask}
        />
      ) : (
        <Notice tone="neutral" title="Can’t be refunded">
          {facts.words}
        </Notice>
      )}
      <Button variant="quiet" onClick={() => setFacts(null)}>
        Close
      </Button>
    </div>
  );
}
