'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { OpsProPrice, OpsProPriceRow } from '@tipme/contracts';
import {
  Button,
  Card,
  EmptyState,
  Notice,
  Skeleton,
  TextareaField,
} from '@tipme/ui';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import { when } from '@/lib/ops-client';
import { refusalWords } from '@/lib/ops-answers';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';
import type { SessionResult } from '@/lib/session-client';

/** The board's step: ₦500, within the server's limits (₦100 to ₦1,000,000). */
const STEP_MINOR = BigInt(50_000);
const KOBO = BigInt(100);

const naira = (amountMinor: bigint) =>
  `₦${(amountMinor / KOBO).toLocaleString('en-NG')}`;

const staffWord = (id: string | null) => (id ? `staff …${id.slice(-6)}` : '');

function who(row: OpsProPriceRow): string {
  if (!row.setBy) return 'Launch price (owner’s decision)';
  const asked = `Asked by ${staffWord(row.setBy)}`;
  return row.approvedBy
    ? `${asked}, approved by ${staffWord(row.approvedBy)}`
    : `${asked}, alone (no second person)`;
}

/**
 * The Pro price (board OpsProPrice; ADR-0015). One month of Pro costs what this says, for new
 * months only. A change needs a second person; a lone admin's change runs with an alert.
 */
export default function ProPricePage() {
  const id = useId();
  const [state, setState] = useState<OpsProPrice | null>(null);
  const [failed, setFailed] = useState(false);
  const [price, setPrice] = useState<bigint | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);

  const apply = useCallback((result: SessionResult<OpsProPrice>) => {
    if (!result.ok) return setFailed(true);
    setState(result.data);
    setPrice(
      (current) =>
        current ??
        (result.data.current ? BigInt(result.data.current.amountMinor) : null),
    );
  }, []);

  useEffect(() => {
    void opsFetch<OpsProPrice>('/v1/ops/pro-price').then(apply);
  }, [apply]);

  if (failed)
    return (
      <section className="dashboard-section">
        <h1>Pro price</h1>
        <Notice tone="error" title="Couldn’t load the Pro price">
          Your role may not include it, or the connection failed.
        </Notice>
      </section>
    );
  if (!state)
    return (
      <section className="dashboard-section">
        <h1>Pro price</h1>
        <Skeleton label="Loading the Pro price" />
      </section>
    );

  const min = BigInt(state.limits.minMinor);
  const max = BigInt(state.limits.maxMinor);
  const shown = price ?? min;
  const live = state.current ? BigInt(state.current.amountMinor) : null;
  const clamp = (value: bigint) =>
    value < min ? min : value > max ? max : value;

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const reason = String(new FormData(form).get('reason') ?? '').trim();
    if (shown === live)
      return setError('Choose a price different from the one in use now.');
    if (reason.length < 10)
      return setError('Please write a reason of at least 10 characters.');
    setBusy(true);
    setError('');
    const answer = await opsAct<OpsProPrice>('/v1/ops/pro-price', {
      method: 'POST',
      body: { amountMinor: String(shown), reason },
    });
    setBusy(false);
    if (answer.kind === 'refused')
      return setError(
        answer.code === 'VALIDATION_FAILED'
          ? 'Check the price: whole naira, ₦100 to ₦1,000,000.'
          : refusalWords(answer),
      );
    form.reset();
    setOutcome(
      outcomeOf(
        answer,
        `The Pro price is now ${naira(shown)} a month for new months.`,
        'The price on the Pro page stays the same until then.',
      ),
    );
    apply(await opsFetch<OpsProPrice>('/v1/ops/pro-price'));
  };

  return (
    <section className="dashboard-section">
      <h1>Pro price</h1>
      <p className="tm-hint">
        This is the price of a month of Pro. A change applies to new months
        only: months already paid or being paid aren’t changed.
      </p>

      <Card className="settings-section">
        <h2>On the Pro page now</h2>
        <p data-testid="pro-price-live">
          <strong>
            {live === null ? 'Not set' : `${naira(live)} a month`}
          </strong>
        </p>
        {state.current && (
          <p className="tm-hint">Since {when(state.current.effectiveFrom)}</p>
        )}
      </Card>

      <Card className="settings-section">
        <h2>Change the price</h2>
        {outcome && <ActionOutcome outcome={outcome} />}
        {state.waitingRequestId && !outcome && (
          <Notice tone="neutral" title="Waiting for a second person">
            A change is waiting in Approvals. The price hasn’t changed yet.
          </Notice>
        )}
        <form className="ops-reason" onSubmit={(e) => void send(e)} noValidate>
          <div
            role="group"
            aria-labelledby={`${id}-label`}
            className="ops-stepper"
          >
            <p id={`${id}-label`}>Price per month</p>
            <Button
              type="button"
              variant="secondary"
              aria-label="₦500 less"
              disabled={shown <= min}
              onClick={() => setPrice(clamp(shown - STEP_MINOR))}
            >
              −
            </Button>
            <output aria-live="polite" data-testid="pro-price-new">
              {naira(shown)}
            </output>
            <Button
              type="button"
              variant="secondary"
              aria-label="₦500 more"
              disabled={shown >= max}
              onClick={() => setPrice(clamp(shown + STEP_MINOR))}
            >
              +
            </Button>
          </div>
          <TextareaField
            id={`${id}-reason`}
            name="reason"
            label="Reason for this change"
            hint="Recorded in the audit log with your name and the time."
            maxLength={500}
          />
          {error && (
            <Notice tone="error" title="Not done">
              {error}
            </Notice>
          )}
          <Button type="submit" disabled={busy} aria-busy={busy}>
            Ask for approval
          </Button>
          <p className="tm-hint">
            Another qualified person approves. A lone admin saves it alone, with
            an alert.
          </p>
        </form>
      </Card>

      <Card className="settings-section">
        <h2 id={`${id}-history`}>History</h2>
        {state.history.length === 0 ? (
          <EmptyState title="No changes yet">
            Prices appear here once set.
          </EmptyState>
        ) : (
          <ol aria-labelledby={`${id}-history`} className="ops-list">
            {state.history.map((row) => (
              <li key={row.id}>
                <strong>{naira(BigInt(row.amountMinor))} a month</strong> ·{' '}
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
