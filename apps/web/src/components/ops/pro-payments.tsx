'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import type { OpsProPayment, OpsProPayments } from '@tipme/contracts';
import { Badge, Button, Card, EmptyWell, Skeleton, Slip } from '@tipme/ui';
import { nairaCode as naira } from '@/lib/money';
import { when } from '@/lib/ops-client';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';
import {
  proPaymentMethodWords,
  proRefundOffer,
  proRefundStateWords,
} from '@/lib/pro-payment-view';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from './action-outcome';
import { ReasonAction } from './reason-action';

const day = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
});
const month = (period: OpsProPayment['period']) =>
  period
    ? `${day.format(new Date(period.startsAt))} to ${day.format(new Date(period.endsAt))}`
    : 'Not recorded';

/**
 * A page's Pro payments (16 Nov 2026), for staff with `payments.repair`: every paid month, newest
 * first, and a reasoned "Refund…" on a card month the member asked to have back (`pro.refund`,
 * a second person approves). The history shows whatever the `pro_refunds` switch; with it off the
 * card says so plainly and offers no button. Our payment partner is never named.
 */
export function ProPayments({ profileId }: { profileId: string }) {
  const id = useId();
  const [read, setRead] = useState<
    { ok: true; data: OpsProPayments } | { ok: false } | null
  >(null);
  const [asking, setAsking] = useState<OpsProPayment | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const path = `/v1/ops/pro/pages/${profileId}/payments`;

  const load = useCallback(async () => {
    const result = await opsFetch<OpsProPayments>(path);
    setRead(result.ok ? { ok: true, data: result.data } : { ok: false });
  }, [path]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing is set before the await
    void load();
  }, [load]);

  const ask = async (payment: OpsProPayment, reason: string) => {
    const answer = await opsAct<{ refundId: string; amountMinor: string }>(
      `/v1/ops/pro/purchases/${payment.purchaseId}/refund`,
      { method: 'POST', body: { reason } },
    );
    if (answer.kind === 'refused') {
      // What is true now matters more than the row on screen: read it again.
      if (
        outcomeIsUnknown(answer) ||
        answer.code === 'PRO_REFUND_REFUSED' ||
        answer.code === 'PRO_REFUNDS_OFF'
      )
        await load();
      return answer.code === 'PRO_REFUNDS_OFF'
        ? 'Pro refunds were switched off. Nothing was asked.'
        : answer.code === 'PRO_REFUND_REFUSED'
          ? 'This payment can’t be refunded now. Nothing was asked; the list says why.'
          : refusalWords(answer);
    }
    setAsking(null);
    setOutcome(
      outcomeOf(
        answer,
        `Refund of ${naira(payment.amountMinor)} asked. It goes to our payment partner next; the member’s Pro month ends when they confirm it.`,
        'Nothing is refunded until a second person approves.',
      ),
    );
    await load();
    return null;
  };

  const titleId = `${id}-title`;
  if (!read)
    return (
      <Card className="settings-section">
        <h2 id={titleId}>Pro payments</h2>
        <Skeleton label="Loading Pro payments" />
      </Card>
    );
  if (!read.ok)
    return (
      <Card className="settings-section">
        <h2 id={titleId}>Pro payments</h2>
        <Slip
          dense
          tone="error"
          title="Couldn’t load the Pro payments"
          actions={
            <Button variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          Check your connection and try again.
        </Slip>
      </Card>
    );
  const { refundsOn, payments } = read.data;
  return (
    <Card
      className="settings-section ops-pro-payments"
      data-testid="pro-payments"
    >
      <h2 id={titleId}>Pro payments</h2>
      {outcome && <ActionOutcome outcome={outcome} />}
      {!refundsOn && payments.length > 0 && (
        <Slip dense tone="neutral" title="Pro refunds aren’t switched on">
          The payments show here, but none can be refunded from TipMe until the
          Pro refunds switch is on.
        </Slip>
      )}
      {payments.length === 0 ? (
        <EmptyWell title="No Pro payments" headingLevel={3}>
          <p>This page hasn’t paid for Pro. Pro given by staff isn’t listed.</p>
        </EmptyWell>
      ) : (
        <div
          className="ops-table-wrap"
          role="region"
          aria-labelledby={titleId}
          tabIndex={0}
        >
          <table className="ops-table ops-table--stack">
            <caption className="sr-only">Pro payments, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Paid</th>
                <th scope="col">Month</th>
                <th scope="col">Method</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Refund</th>
                <th scope="col">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => {
                const offer = proRefundOffer(payment, { refundsOn });
                return (
                  <tr key={payment.purchaseId}>
                    <td data-label="Paid">
                      {payment.paidAt ? when(payment.paidAt) : '—'}
                    </td>
                    <td data-label="Month">{month(payment.period)}</td>
                    <td data-label="Method">
                      {proPaymentMethodWords(payment.paidBy)}
                    </td>
                    <td data-label="Amount">{naira(payment.amountMinor)}</td>
                    <td data-label="Status">
                      <span>
                        <Badge
                          className={
                            payment.refund?.status === 'PAID'
                              ? 'ops-pay-state ops-pay-state--refunded'
                              : 'ops-pay-state ops-pay-state--paid'
                          }
                        >
                          {payment.refund?.status === 'PAID'
                            ? 'Refunded'
                            : 'Paid'}
                        </Badge>
                      </span>
                    </td>
                    <td data-label="Refund">
                      <span>
                        {proRefundStateWords(payment.refund)}
                        {offer.kind === 'not_refundable' && (
                          <span className="tm-hint ops-pay-why">
                            {offer.words}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="ops-table__action">
                      {offer.kind === 'ask' && (
                        <Button
                          variant="quiet"
                          aria-label={`Refund the ${naira(payment.amountMinor)} payment of ${payment.paidAt ? when(payment.paidAt) : 'this month'}…`}
                          aria-expanded={
                            asking?.purchaseId === payment.purchaseId
                          }
                          onClick={() => {
                            setOutcome(null);
                            setAsking(payment);
                          }}
                        >
                          Refund…
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {asking && (
        <section
          className="ops-pro-refund"
          aria-label="Refund this Pro payment"
          data-testid="pro-refund"
        >
          <p>
            The member gets <strong>{naira(asking.amountMinor)}</strong> back on
            the card they paid with, the full amount: TipMe pays the card fee.
            Their Pro month ({month(asking.period)}) ends when our payment
            partner confirms the refund, unless another paid month or a staff
            grant still covers today.
          </p>
          <p className="tm-hint">
            Only on the member’s own request, within 14 days of paying.
          </p>
          <ReasonAction
            key={asking.purchaseId}
            startOpen
            open="Refund…"
            field="What did the member ask, and how?"
            submit="Ask for the refund"
            hint="Recorded in the audit log with your name and the time. A second person approves before anything is refunded."
            onSubmit={(reason) => ask(asking, reason)}
            onCancel={() => setAsking(null)}
          />
        </section>
      )}
    </Card>
  );
}
