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

/** Each price this screen sets: personal Pro always; Business Pro once its route answers. */
const PLANS = {
  personal: {
    title: 'Personal Pro',
    path: '/v1/ops/pro-price',
    testId: 'pro-price',
    shownOn: 'the Pro page',
  },
  business: {
    title: 'Business Pro',
    path: '/v1/ops/business-pro-price',
    testId: 'business-pro-price',
    shownOn: 'Business → Plan',
  },
} as const;
type Plan = keyof typeof PLANS;

const PLAN_WORD: Record<OpsProPriceRow['plan'], string> = {
  personal: 'Personal Pro',
  business: 'Business Pro',
};

/**
 * One price's card: what it is now, and a change with a reason. A change needs a second person; a
 * lone admin's change runs with an alert. Each card asks on its own, so a change waiting for one
 * never touches the other.
 */
function PriceCard({
  plan,
  state,
  onChanged,
}: {
  plan: Plan;
  state: OpsProPrice;
  onChanged: () => Promise<void>;
}) {
  const id = useId();
  const words = PLANS[plan];
  const live = state.current ? BigInt(state.current.amountMinor) : null;
  const [price, setPrice] = useState<bigint | null>(live);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);

  const min = BigInt(state.limits.minMinor);
  const max = BigInt(state.limits.maxMinor);
  const shown = price ?? live ?? min;
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
    const answer = await opsAct<OpsProPrice>(words.path, {
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
        `The ${words.title} price is now ${naira(shown)} a month for new months.`,
        `The price in ${words.shownOn} stays the same until then.`,
      ),
    );
    await onChanged();
  };

  return (
    <section aria-label={`${words.title} price`}>
      <Card className="settings-section">
        <h2>{words.title}</h2>
        <p data-testid={`${words.testId}-live`}>
          <strong>
            {live === null ? 'Not set' : `${naira(live)} a month`}
          </strong>
        </p>
        {state.current && (
          <p className="tm-hint">
            In {words.shownOn} since {when(state.current.effectiveFrom)}
          </p>
        )}
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
            <output aria-live="polite" data-testid={`${words.testId}-new`}>
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
        </form>
      </Card>
    </section>
  );
}

/** Both histories as one list, newest first, each row with its plan and the price it replaced. */
function mergedHistory(states: OpsProPrice[]) {
  const rows = states.flatMap((state) => state.history);
  const newestFirst = [...rows].sort(
    (a, b) =>
      b.effectiveFrom.localeCompare(a.effectiveFrom) ||
      b.createdAt.localeCompare(a.createdAt),
  );
  return newestFirst.map((row) => {
    const before = newestFirst.find(
      (other) =>
        other.plan === row.plan &&
        other !== row &&
        (other.effectiveFrom < row.effectiveFrom ||
          (other.effectiveFrom === row.effectiveFrom &&
            other.createdAt < row.createdAt)),
    );
    return { row, was: before ? BigInt(before.amountMinor) : null };
  });
}

/** Both prices at once; Business Pro's is 404 while BUSINESS_PRO_ENABLED is off. */
const readBoth = () =>
  Promise.all([
    opsFetch<OpsProPrice>(PLANS.personal.path),
    opsFetch<OpsProPrice>(PLANS.business.path),
  ]);

/**
 * Prices (board BusinessPro section 4; board OpsProPrice; ADR-0015): what one month of Pro costs,
 * personal and, with BUSINESS_PRO_ENABLED on, Business Pro. A change applies to new months only.
 * The Business Pro card shows only when its route answers (it is 404 with the flag off).
 */
export default function PricesPage() {
  const id = useId();
  const [states, setStates] = useState<Partial<Record<Plan, OpsProPrice>>>({});
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const apply = useCallback(
    ([personal, business]: SessionResult<OpsProPrice>[]) => {
      if (!personal?.ok) return setFailed(true);
      setStates({
        personal: personal.data,
        business: business?.ok ? business.data : undefined,
      });
      setLoaded(true);
    },
    [],
  );
  const load = useCallback(async () => apply(await readBoth()), [apply]);

  useEffect(() => {
    void readBoth().then(apply);
  }, [apply]);

  if (failed)
    return (
      <section className="dashboard-section">
        <h1>Prices</h1>
        <Notice tone="error" title="Couldn’t load the prices">
          Your role may not include them, or the connection failed.
        </Notice>
      </section>
    );
  if (!loaded || !states.personal)
    return (
      <section className="dashboard-section">
        <h1>Prices</h1>
        <Skeleton label="Loading the prices" />
      </section>
    );

  const shownStates = [states.personal, states.business].filter(
    (state): state is OpsProPrice => state !== undefined,
  );
  const history = mergedHistory(shownStates);

  return (
    <section className="dashboard-section">
      <h1>Prices</h1>
      <p className="tm-hint">
        What one month costs, shown on the Pro page
        {states.business ? ' and in Business → Plan' : ''}. A change applies to
        new months only: months already paid or being paid aren’t changed.
      </p>

      <div className="ops-prices">
        <PriceCard plan="personal" state={states.personal} onChanged={load} />
        {states.business && (
          <PriceCard plan="business" state={states.business} onChanged={load} />
        )}
      </div>

      <Notice
        tone="neutral"
        title="New price applies to the next renewal; the shown price is honoured."
      >
        Someone mid-purchase pays what they saw, or is asked to confirm the new
        price. Another qualified person approves each change; a lone admin saves
        it alone, with an alert.
      </Notice>

      <Card className="settings-section">
        <h2 id={`${id}-history`}>History</h2>
        {history.length === 0 ? (
          <EmptyState title="No changes yet">
            Prices appear here once set.
          </EmptyState>
        ) : (
          <ol aria-labelledby={`${id}-history`} className="ops-list">
            {history.map(({ row, was }) => (
              <li key={row.id}>
                <strong>{naira(BigInt(row.amountMinor))} a month</strong> ·{' '}
                {PLAN_WORD[row.plan]} · {when(row.effectiveFrom)} · {who(row)}
                {was !== null && <> · was {naira(was)}</>}
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
