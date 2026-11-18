'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { OpsPlanFees, OpsPlanFeesRow } from '@tipme/contracts';
import {
  Button,
  Card,
  EmptyWell,
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
import { bpsToPercent, percentToBps } from '@/lib/fee-percent';
import { refusalWords } from '@/lib/ops-answers';
import { when } from '@/lib/ops-client';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

const PATH = '/v1/ops/plan-fees';

const staffWord = (id: string | null) => (id ? `staff …${id.slice(-6)}` : '');

function who(row: OpsPlanFeesRow): string {
  if (!row.setBy) return 'Starting rates (owner’s decision)';
  const asked = `Asked by ${staffWord(row.setBy)}`;
  return row.approvedBy
    ? `${asked}, approved by ${staffWord(row.approvedBy)}`
    : `${asked}, alone (no second person)`;
}

/**
 * TipMe's fee per plan (owner, 18 Nov 2026): what TipMe keeps of each new tip on Free and on Pro,
 * payment and withdrawal fees included. A change is a money change: another qualified person
 * approves it (a lone admin saves it alone, with an alert, as every money switch), it is audited, and
 * it applies to new quotes only. Business tips use the staff member's own plan rate; the business
 * payout fee is a money switch, shown here and changed in Switches.
 */
export default function PlanFeesPage() {
  const id = useId();
  const [state, setState] = useState<OpsPlanFees | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);

  const load = useCallback(async () => {
    const result = await opsFetch<OpsPlanFees>(PATH);
    if (!result.ok) return setFailed(true);
    setFailed(false);
    setState(result.data);
  }, []);

  useEffect(() => {
    void opsFetch<OpsPlanFees>(PATH).then((result) => {
      if (!result.ok) return setFailed(true);
      setState(result.data);
    });
  }, []);

  if (failed)
    return (
      <section className="dashboard-section ops-page-body">
        <h1>Fees</h1>
        <LoadFailed dense title="Couldn’t load the fees" onRetry={load}>
          Your role may not include them, or the connection failed.
        </LoadFailed>
      </section>
    );
  if (!state)
    return (
      <section className="dashboard-section ops-page-body">
        <h1>Fees</h1>
        <Skeleton label="Loading the fees" />
      </section>
    );

  const { current } = state;
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const freeBps = percentToBps(String(data.get('free') ?? ''));
    const proBps = percentToBps(String(data.get('pro') ?? ''));
    const reason = String(data.get('reason') ?? '').trim();
    if (freeBps === null || proBps === null)
      return setError(
        'Write each fee as a percentage from 0 to 100, for example 5 or 4.5.',
      );
    if (proBps > freeBps)
      return setError('Pro’s fee can’t be higher than Free’s.');
    if (freeBps === current.freeBps && proBps === current.proBps)
      return setError('Choose fees different from the ones in use now.');
    if (reason.length < 10)
      return setError('Please write a reason of at least 10 characters.');
    setBusy(true);
    setError('');
    const answer = await opsAct<OpsPlanFees>(PATH, {
      method: 'POST',
      body: { freeBps: String(freeBps), proBps: String(proBps), reason },
    });
    setBusy(false);
    if (answer.kind === 'refused')
      return setError(
        answer.code === 'VALIDATION_FAILED'
          ? 'Check the fees: 0% to 100%, and Pro no higher than Free.'
          : refusalWords(answer),
      );
    form.reset();
    setOutcome(
      outcomeOf(
        answer,
        `TipMe now keeps ${bpsToPercent(freeBps)} on Free and ${bpsToPercent(proBps)} on Pro, for new tips.`,
        'The fees in use stay the same until then.',
      ),
    );
    await load();
  };

  return (
    <section className="dashboard-section ops-page-body">
      <h1>Fees</h1>
      <p className="tm-hint">
        What TipMe keeps of each tip, payment and withdrawal fees included. A
        change applies to new tips only: a price already shown to a supporter,
        and every tip already paid, keep their fee.
      </p>

      <div className="ops-prices">
        <section aria-label="Personal fees">
          <Card className="settings-section">
            <h2>Personal: Free / Pro</h2>
            <p data-testid="plan-fees-live">
              <strong>
                Free {bpsToPercent(current.freeBps)} · Pro{' '}
                {bpsToPercent(current.proBps)}
              </strong>{' '}
              of each tip
            </p>
            <p className="tm-hint">
              {current.effectiveFrom
                ? `In use since ${when(current.effectiveFrom)}`
                : 'TipMe’s starting fees (none set here yet)'}
            </p>
            {outcome && <ActionOutcome outcome={outcome} />}
            {state.waitingRequestId && !outcome && (
              <Slip dense tone="waiting" title="Waiting for a second person">
                A change is waiting in Approvals. The fees haven’t changed yet.
              </Slip>
            )}
            <form
              className="ops-reason"
              onSubmit={(e) => void send(e)}
              noValidate
            >
              <InputField
                id={`${id}-free`}
                name="free"
                label="Free plan fee (%)"
                hint="For example 5 or 4.5."
                defaultValue={bpsToPercent(current.freeBps).replace('%', '')}
                inputMode="decimal"
              />
              <InputField
                id={`${id}-pro`}
                name="pro"
                label="Pro plan fee (%)"
                hint="No higher than Free’s."
                defaultValue={bpsToPercent(current.proBps).replace('%', '')}
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
        </section>

        <section aria-label="Business fees">
          <Card className="settings-section">
            <h2>Business: tips / Business Pro</h2>
            <p>
              A tip at a business uses the staff member’s own plan fee above
              (Free or Pro). Business and Business Pro have no separate tip fee.
            </p>
            <p data-testid="business-payout-fee">
              Business withdrawals:{' '}
              <strong>
                {state.business.payoutFeeAbsorbed
                  ? 'TipMe pays the transfer fee'
                  : 'the business pays the transfer fee from the amount'}
              </strong>
              .
            </p>
            <p className="tm-hint">
              Changed in <Link href="/ops/switches">Switches</Link> (“TipMe pays
              business payout fees”), with a second person.
            </p>
          </Card>
        </section>
      </div>

      <Card className="settings-section">
        <h2 id={`${id}-history`}>History</h2>
        {state.history.length === 0 ? (
          <EmptyWell title="No changes yet" headingLevel={3}>
            <p>Fees appear here once set.</p>
          </EmptyWell>
        ) : (
          <ol aria-labelledby={`${id}-history`} className="ops-list">
            {state.history.map((row) => (
              <li key={row.id}>
                <strong>
                  Free {bpsToPercent(row.freeBps)} · Pro{' '}
                  {bpsToPercent(row.proBps)}
                </strong>{' '}
                · {when(row.effectiveFrom)} · {who(row)}
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
