'use client';
import { useState } from 'react';
import type { OpsTipRefund } from '@tipme/contracts';
import { Button, Slip } from '@tipme/ui';
import { nairaCode as naira } from '@/lib/money';
import { can, useOpsAccess } from '@/lib/ops-client';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';
import { ActionOutcome, type ActionOutcomeState } from './action-outcome';
import { CollectAct } from './collect-act';
import { ReasonAction } from './reason-action';
import { Money } from '@/components/money';

/**
 * Staff "Refund tip…" (owner, 14 Nov 2026), behind the `tip_refunds` admin switch. Says exactly what the supporter
 * gets back (the tip minus TipMe's fee, which TipMe keeps) and who gives back what, then asks with
 * a written reason; a second person approves. Our payment partner is never named.
 */
export function TipRefund({ tipId }: { tipId: string }) {
  const [facts, setFacts] = useState<OpsTipRefund | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const path = `/v1/ops/tips/${tipId}/refund`;
  const manage = can(useOpsAccess(), 'collect.manage');

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

  const ask = async (
    reason: string,
    to: string = path,
  ): Promise<string | null> => {
    const answer = await opsAct<{ refundId: string; amountMinor: string }>(to, {
      method: 'POST',
      body: { reason },
    });
    if (answer.kind === 'refused')
      return answer.code === 'TIP_REFUND_REFUSED' ||
        answer.code === 'TIP_REFUND_NEEDS_DECISION' ||
        answer.code === 'TIP_REFUND_NO_GAP'
        ? 'This tip can’t be refunded this way now. Open it again to see why.'
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
            text: to.endsWith('/return')
              ? `Return of ${naira(answer.data.amountMinor)} asked. It goes back to their account with our payment partner next.`
              : `Refund of ${naira(answer.data.amountMinor)} asked. It goes to our payment partner next, and is recorded when they confirm it.`,
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
          <Slip dense tone="error" title="Not open">
            {problem}
          </Slip>
        )}
      </span>
    );
  const page = facts.handle ? `@${facts.handle}` : 'The page';
  const collect = facts.refundable ? facts.collect : undefined;
  return (
    <div className="tip-refund" data-testid="tip-refund">
      <p>
        The supporter gets back{' '}
        <strong>
          <Money code minor={facts.refundMinor} />
        </strong>
        : the <Money code minor={facts.grossMinor} /> tip minus TipMe’s{' '}
        <Money code minor={facts.feeMinor} /> fee, which TipMe keeps.
      </p>
      <p>
        {page} gives back <Money code minor={facts.personMinor} />
        {facts.businessName ? (
          <>
            {' '}
            and {facts.businessName} gives back{' '}
            <Money code minor={facts.businessMinor} />: what each received.
          </>
        ) : (
          ': what they received.'
        )}
      </p>
      {collect && <CollectPlan plan={collect} page={page} />}
      {facts.lastFailure && (
        <Slip dense tone="neutral" title="The last refund didn’t go through">
          {facts.lastFailure}
        </Slip>
      )}
      {facts.unbookedMinor && facts.unbookedMinor !== '0' && (
        <Slip dense tone="error" title="A refund TipMe didn’t record">
          Our payment partner refunded{' '}
          <strong>
            <Money code minor={facts.unbookedMinor} />
          </strong>{' '}
          of this tip, but TipMe didn’t expect it and hasn’t recorded it. Settle
          the money issue first.
        </Slip>
      )}
      {/* You collect (Task 15, RI3): book it, from what TipMe holds for the tip; TipMe absorbs the rest. */}
      {facts.unbookedMinor && facts.unbookedMinor !== '0' && manage && (
        <CollectAct
          path={`/v1/ops/collect/refunds/${tipId}/record-paid`}
          open="Record this refund…"
          field="What you checked in the partner dashboard"
          submit="Ask to record it"
          done="Recorded: the refund is booked from what TipMe held for this tip, and TipMe absorbed the rest."
          meanwhile="Nothing is booked until then."
        />
      )}
      {facts.heldMinor && facts.heldMinor !== '0' && (
        <Slip dense tone="unsure" title="Money held for this tip">
          <strong>
            <Money code minor={facts.heldMinor} />
          </strong>{' '}
          was taken back from {page} for a refund and is held by TipMe. A new
          refund uses it, or it can be returned to their account with our
          payment partner.
        </Slip>
      )}
      {facts.heldMinor && facts.heldMinor !== '0' && !facts.refund && (
        <ReasonAction
          open="Return to recipient"
          field="Why is this money going back to the recipient?"
          submit="Ask a second person"
          hint="Recorded in the audit log with your name and the time. A second person decides before anything is sent back."
          onSubmit={(reason) => ask(reason, `${path}/return`)}
        />
      )}
      {facts.refundable && collect?.plan === 'staff_decides' ? (
        <ReasonAction
          open="Refund and absorb the gap"
          field="Why should TipMe refund this and absorb the gap?"
          submit="Ask a second person"
          hint="Recorded in the audit log with your name and the time. A second person decides before anything is taken back or refunded."
          onSubmit={(reason) => ask(reason, `${path}/absorb-gap`)}
        />
      ) : facts.refundable ? (
        <ReasonAction
          open="Ask to refund"
          field="Why is this tip being refunded?"
          submit="Ask for the refund"
          hint="Recorded in the audit log with your name and the time. A second person approves before anything is refunded."
          onSubmit={ask}
        />
      ) : (
        <Slip dense tone="neutral" title="Can’t be refunded">
          {facts.words}
        </Slip>
      )}
      <Button variant="quiet" onClick={() => setFacts(null)}>
        Close
      </Button>
    </div>
  );
}

/**
 * You collect (plan Task 10): the tip was charged to TipMe's own account, so the refund comes from
 * TipMe's balance once the recipient's part is back. Says how it comes back, and when part of it
 * can't, how much TipMe would absorb.
 */
function CollectPlan({
  plan,
  page,
}: {
  plan: NonNullable<OpsTipRefund['collect']>;
  page: string;
}) {
  if (plan.plan === 'cancel_held')
    return (
      <p>
        TipMe still holds {page}’s share, so the refund comes from TipMe’s
        balance and the share is cancelled once the refund is confirmed.
      </p>
    );
  if (plan.plan === 'take_back')
    return (
      <p>
        {page}’s share has moved to their account. TipMe takes it back first,
        then refunds from its own balance.
      </p>
    );
  if (plan.plan !== 'staff_decides') return null;
  return (
    <Slip dense tone="unsure" title="Part of this tip can’t be taken back">
      Up to{' '}
      <strong>
        <Money code minor={plan.gapMinor} />
      </strong>{' '}
      is no longer there to take back: the recipient (or the business) has
      already withdrawn it. TipMe would pay that from its own balance as a loss.
      Whatever is still there is taken back first. A second person decides
      whether TipMe goes ahead.
    </Slip>
  );
}
