'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { OpsCardCosts, OpsCardCostsRow } from '@tipme/contracts';
import {
  Button,
  Card,
  InputField,
  Skeleton,
  Slip,
  TextareaField,
} from '@tipme/ui';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import { LoadFailed } from '@/components/dashboard/load-failed';
import {
  cardCostForm,
  cardCostSummary,
  cardOfferLine,
  koboToNaira,
} from '@/lib/card-cost-view';
import { bpsToPercent } from '@/lib/fee-percent';
import { refusalWords } from '@/lib/ops-answers';
import { when } from '@/lib/ops-client';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

const PATH = '/v1/ops/card-costs';

const staffWord = (id: string | null) => (id ? `staff …${id.slice(-6)}` : '');

function who(row: OpsCardCostsRow): string {
  const asked = `Asked by ${staffWord(row.setBy)}`;
  return row.approvedBy
    ? `${asked}, approved by ${staffWord(row.approvedBy)}`
    : `${asked}, alone (no second person)`;
}

/**
 * What a card payment costs TipMe (owner, 26 Nov 2026): the card fee rate, the 3D Secure fixed
 * cost and a margin. Card is offered on a tip only when TipMe's share covers them, so this sets the
 * tip amount from which each plan offers card. A money change: another qualified person approves it
 * (a lone admin saves it alone, with an alert), audited, for new checkouts only.
 */
export function CardCosts({
  rates,
  onLoaded,
}: {
  rates: { freeBps: number; proBps: number };
  /** Told the card cost in force each time it loads, so the plan fee boxes can say where card starts. */
  onLoaded?: (current: OpsCardCosts['current']) => void;
}) {
  const id = useId();
  const [state, setState] = useState<OpsCardCosts | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);

  const load = useCallback(async () => {
    const result = await opsFetch<OpsCardCosts>(PATH);
    if (!result.ok) return setFailed(true);
    setFailed(false);
    setState(result.data);
    onLoaded?.(result.data.current);
  }, [onLoaded]);

  useEffect(() => {
    void opsFetch<OpsCardCosts>(PATH).then((result) => {
      if (!result.ok) return setFailed(true);
      setState(result.data);
      onLoaded?.(result.data.current);
    });
  }, [onLoaded]);

  if (failed)
    return (
      <Card className="settings-section">
        <h2>Card costs</h2>
        <LoadFailed dense title="Couldn’t load the card costs" onRetry={load}>
          Your role may not include them, or the connection failed.
        </LoadFailed>
      </Card>
    );
  if (!state)
    return (
      <Card className="settings-section">
        <h2>Card costs</h2>
        <Skeleton label="Loading the card costs" />
      </Card>
    );

  const { current } = state;
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const checked = cardCostForm(
      {
        rate: String(data.get('rate') ?? ''),
        fixed: String(data.get('fixed') ?? ''),
        margin: String(data.get('margin') ?? ''),
        reason: String(data.get('reason') ?? ''),
      },
      current,
    );
    if (!checked.ok) return setError(checked.error);
    setBusy(true);
    setError('');
    const answer = await opsAct<OpsCardCosts>(PATH, {
      method: 'POST',
      body: checked.body,
    });
    setBusy(false);
    if (answer.kind === 'refused')
      return setError(
        answer.code === 'VALIDATION_FAILED'
          ? 'Check the figures: a card fee from 0% to 100%, and naira amounts of 0 or more.'
          : refusalWords(answer),
      );
    form.reset();
    setOutcome(
      outcomeOf(
        answer,
        `Card costs are now ${cardCostSummary(checked.body).replace(/^Card fee /, '')}, for new checkouts.`,
        'The card costs in use stay the same until then.',
      ),
    );
    await load();
  };

  return (
    <section aria-label="Card costs" className="dashboard-section">
      <Card className="settings-section">
        <h2>Card costs</h2>
        <p className="tm-hint">
          What a card payment costs TipMe. Card is offered on a tip only when
          TipMe’s fee on it covers the card fee and the margin; bank transfer is
          always offered.
        </p>
        <p data-testid="card-costs-live">
          <strong>{cardCostSummary(current)}</strong>
        </p>
        <p data-testid="card-costs-offer">{cardOfferLine(rates, current)}</p>
        <p className="tm-hint">
          {current.effectiveFrom
            ? `In use since ${when(current.effectiveFrom)}`
            : 'TipMe’s starting card costs (none set here yet)'}
        </p>
        {outcome && <ActionOutcome outcome={outcome} />}
        {state.waitingRequestId && !outcome && (
          <Slip dense tone="waiting" title="Waiting for a second person">
            A change is waiting in Approvals. The card costs haven’t changed
            yet.
          </Slip>
        )}
        <form className="ops-reason" onSubmit={(e) => void send(e)} noValidate>
          <InputField
            id={`${id}-rate`}
            name="rate"
            label="Card fee (%)"
            hint="The partner’s card rate, for example 2 or 1.5."
            defaultValue={bpsToPercent(current.rateBps).replace('%', '')}
            inputMode="decimal"
          />
          <InputField
            id={`${id}-fixed`}
            name="fixed"
            label="3D Secure cost (₦)"
            hint="The fixed cost of each card payment, for example 45."
            defaultValue={koboToNaira(current.fixedMinor)}
            inputMode="decimal"
          />
          <InputField
            id={`${id}-margin`}
            name="margin"
            label="Margin (₦)"
            hint="What TipMe keeps above the card cost before offering card."
            defaultValue={koboToNaira(current.marginMinor)}
            inputMode="decimal"
          />
          <TextareaField
            id={`${id}-reason`}
            name="reason"
            label="Reason for this change"
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
            Ask for approval
          </Button>
        </form>
      </Card>
      <Card className="settings-section">
        <h2 id={`${id}-history`}>Card cost history</h2>
        {state.history.length === 0 ? (
          <p className="tm-hint">No changes yet.</p>
        ) : (
          <ol aria-labelledby={`${id}-history`} className="ops-list">
            {state.history.map((row) => (
              <li key={row.id}>
                <strong>{cardCostSummary(row)}</strong> ·{' '}
                {when(row.effectiveFrom)} · {who(row)}
                <br />
                <span className="tm-hint">{row.reason}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </section>
  );
}
