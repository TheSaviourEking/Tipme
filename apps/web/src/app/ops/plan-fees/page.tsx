'use client';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type {
  FeeWaiverFeeName,
  FeeWaiverKindName,
  OpsFeeWaiverCell,
  OpsFeeWaivers,
  OpsPlanFees,
  OpsPlanFeesRow,
} from '@tipme/contracts';
import { FEE_WAIVER_STAFF_COPY as C } from '@tipme/contracts/copy';
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
import {
  normalWords,
  tipmePaysWords,
  WaiverCost,
} from '@/components/ops/account-fee-waivers';
import { withAmount } from '@/components/dashboard/collect-status';
import { LoadFailed } from '@/components/dashboard/load-failed';
import type { CardCostFigures } from '@/lib/card-cost-view';
import { bpsToPercent, percentToBps } from '@/lib/fee-percent';
import {
  endOfLagosDay,
  fromLabel,
  lagosToday,
  startOfLagosDay,
} from '@/lib/fee-waiver-dates';
import { refusalWords, type OpsAnswer } from '@/lib/ops-answers';
import {
  loadFeeWaivers,
  setFeeWaiver,
  staffWord,
  when,
} from '@/lib/ops-client';
import {
  BELOW_FLOOR,
  planRateBelowFloor,
  rateCardLine,
  typedRateCardLine,
} from '@/lib/rate-floor';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';
import { CardCosts } from './card-costs';

const PATH = '/v1/ops/plan-fees';
// Matches PLAN_FEE_LARGE_CHANGE_BPS (contracts): the API refuses a bigger move without the flag.
const LARGE_CHANGE_BPS = 200;

function who(row: OpsPlanFeesRow): string {
  if (!row.setBy) return 'Starting rates (owner’s decision)';
  const asked = `Asked by ${staffWord(row.setBy)}`;
  return row.approvedBy
    ? `${asked}, approved by ${staffWord(row.approvedBy)}`
    : `${asked}, alone (no second person)`;
}

/**
 * TipMe's fee per plan (owner, 18 Nov 2026): what TipMe keeps of each new tip on Free and on Pro,
 * payment processing included. A change is a money change: another qualified person
 * approves it (a lone admin saves it alone, with an alert, as every money switch), it is audited, and
 * it applies to new quotes only. Business tips use the staff member's own plan rate. Below, who pays
 * the tip and withdrawal fees for each kind of account (fee waivers, spec 2026-11-23 §6).
 */
export default function PlanFeesPage() {
  const id = useId();
  const [state, setState] = useState<OpsPlanFees | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // A move of more than 2 percentage points on either plan shows a box the person must tick.
  const [bigMove, setBigMove] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  // The card cost in force (the Card costs section loads it) and what is typed in the two fee boxes,
  // so the screen can say, before asking, from what tip amount card is offered at that rate.
  const [cardCost, setCardCost] = useState<CardCostFigures | null>(null);
  const [typed, setTyped] = useState<{
    free: string | null;
    pro: string | null;
  }>({ free: null, pro: null });

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
    const { minBps, maxBps } = state.limits;
    const limits = `${bpsToPercent(minBps)} to ${bpsToPercent(maxBps)}`;
    if (freeBps === null || proBps === null)
      return setError(
        `Write each fee as a percentage from ${limits}, for example 5 or 4.5.`,
      );
    if (
      freeBps < minBps ||
      freeBps > maxBps ||
      proBps < minBps ||
      proBps > maxBps
    )
      return setError(`Each fee must be from ${limits}.`);
    if (proBps > freeBps)
      return setError('Pro’s fee can’t be higher than Free’s.');
    if (freeBps === current.freeBps && proBps === current.proBps)
      return setError('Choose fees different from the ones in use now.');
    if (reason.length < 10)
      return setError('Please write a reason of at least 10 characters.');
    const big =
      Math.abs(freeBps - current.freeBps) > LARGE_CHANGE_BPS ||
      Math.abs(proBps - current.proBps) > LARGE_CHANGE_BPS;
    setBigMove(big);
    const confirmed = data.get('confirm-big') === 'on';
    if (big && !confirmed)
      return setError(
        'That moves a fee by more than 2 percentage points. Tick the box to confirm the big change.',
      );
    setBusy(true);
    setError('');
    const answer = await opsAct<OpsPlanFees>(PATH, {
      method: 'POST',
      body: {
        freeBps: String(freeBps),
        proBps: String(proBps),
        reason,
        ...(big ? { confirmLargeChange: true } : {}),
      },
    });
    setBusy(false);
    if (answer.kind === 'refused')
      return setError(
        answer.code === 'VALIDATION_FAILED'
          ? `Check the fees: ${bpsToPercent(minBps)} to ${bpsToPercent(maxBps)}, and Pro no higher than Free.`
          : answer.code === 'PLAN_FEES_CONFIRM_REQUIRED'
            ? 'That moves a fee by more than 2 percentage points. Tick the box to confirm the big change.'
            : refusalWords(answer),
      );
    form.reset();
    setTyped({ free: null, pro: null });
    setBigMove(false);
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
        What TipMe keeps of each tip, payment processing included. A change
        applies to new tips only: a price already shown to a supporter, and
        every tip already paid, keep their fee.
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
            {(
              [
                ['Free', current.freeBps],
                ['Pro', current.proBps],
              ] as const
            ).map(([plan, bps]) => (
              <p
                key={plan}
                data-testid={`plan-fees-card-${plan.toLowerCase()}`}
              >
                {plan} at {bpsToPercent(bps)}: {rateCardLine(bps, cardCost)}
              </p>
            ))}
            {(
              [
                ['Free', current.freeBps],
                ['Pro', current.proBps],
              ] as const
            )
              .filter(([, bps]) => planRateBelowFloor(bps))
              .map(([plan, bps]) => (
                <Slip
                  key={plan}
                  dense
                  tone="waiting"
                  title={`${plan}: ${BELOW_FLOOR}`}
                >
                  {plan} is {bpsToPercent(bps)}, set before the floor. It stays
                  until it is changed here; a new fee must be{' '}
                  {bpsToPercent(state.limits.minBps)} or more.
                </Slip>
              ))}
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
                hint={`From ${bpsToPercent(state.limits.minBps).replace('%', '')} to ${bpsToPercent(state.limits.maxBps).replace('%', '')}, for example 5 or 4.5.`}
                defaultValue={bpsToPercent(current.freeBps).replace('%', '')}
                inputMode="decimal"
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setTyped((was) => ({ ...was, free: value }));
                }}
              />
              {typed.free !== null &&
                typedRateCardLine(typed.free, cardCost) && (
                  <p className="tm-hint" data-testid="plan-fees-typed-free">
                    {typedRateCardLine(typed.free, cardCost)}
                  </p>
                )}
              <InputField
                id={`${id}-pro`}
                name="pro"
                label="Pro plan fee (%)"
                hint="No higher than Free’s."
                defaultValue={bpsToPercent(current.proBps).replace('%', '')}
                inputMode="decimal"
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setTyped((was) => ({ ...was, pro: value }));
                }}
              />
              {typed.pro !== null && typedRateCardLine(typed.pro, cardCost) && (
                <p className="tm-hint" data-testid="plan-fees-typed-pro">
                  {typedRateCardLine(typed.pro, cardCost)}
                </p>
              )}
              <TextareaField
                id={`${id}-reason`}
                name="reason"
                label="Reason for this change"
                hint="Recorded in the audit log with your name and the time."
                maxLength={500}
              />
              {bigMove && (
                <label className="ops-recovery__confirm">
                  <input type="checkbox" name="confirm-big" /> I confirm this
                  big change (more than 2 percentage points on a plan)
                </label>
              )}
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
          </Card>
        </section>
      </div>

      {/* Owner, 26 Nov 2026: card is offered only where the plan rate above covers the card cost. */}
      <CardCosts
        rates={{ freeBps: current.freeBps, proBps: current.proBps }}
        onLoaded={setCardCost}
      />

      <WhoPays />

      <Card className="settings-section">
        <h2 id={`${id}-history`}>Plan fee history</h2>
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

const KINDS = ['individual', 'business', 'giving'] as const;
const FEES = ['tip', 'withdrawal'] as const;

/** One grid cell's words: who pays this kind's fee now. */
function cellWords(
  kind: FeeWaiverKindName,
  fee: FeeWaiverFeeName,
  cell: OpsFeeWaiverCell,
): string {
  // The cell's `ruleId` can name a row that is in no list (the carried-over business switch, a
  // kind-wide end): the grid reads only the cell, never a lookup that could miss.
  if (kind === 'business' && fee === 'tip') return C.noFee;
  return cell.payer === 'tipme'
    ? tipmePaysWords(cell.endsAt)
    : normalWords(kind, fee);
}

/**
 * A grid cell: who pays now, then each change set to start later (final review I4), so a scheduled
 * waiver is seen before it starts. One element, so a stacked cell on a phone keeps it together.
 */
function CellWords({
  kind,
  fee,
  cell,
}: {
  kind: FeeWaiverKindName;
  fee: FeeWaiverFeeName;
  cell: OpsFeeWaiverCell;
}) {
  return (
    <span>
      {cellWords(kind, fee, cell)}
      {cell.upcoming.map((change) => (
        <span
          key={change.startsAt}
          className="tm-hint ops-cell-next"
          data-testid="fee-waiver-upcoming"
        >
          {C.upcomingChange(
            fromLabel(change.startsAt),
            change.payer === 'tipme'
              ? tipmePaysWords(change.endsAt)
              : normalWords(kind, fee),
          )}
        </span>
      ))}
    </span>
  );
}

type Payer = 'tipme' | 'account';
type Estimate = { minor: string; moved: boolean };

/**
 * The kind-wide change (spec §6: who pays · optional start · optional end · reason). A kind-wide
 * "TipMe pays" first comes back with the live monthly estimate, which the person ticks to confirm;
 * an estimate that moved meanwhile comes back again with its own words. The native dialog keeps
 * focus inside, Escape leaves, and focus goes back to "Change…".
 */
function ChangeWhoPays({
  onClose,
  onAnswered,
}: {
  onClose: () => void;
  onAnswered: (answer: OpsAnswer<OpsFeeWaivers>) => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<FeeWaiverKindName>('individual');
  const [fee, setFee] = useState<FeeWaiverFeeName>('tip');
  const [payer, setPayer] = useState<Payer>('tipme');
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const before = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (before instanceof HTMLElement && before.isConnected)
        before.focus({ preventScroll: true });
    };
  }, []);

  // A figure confirmed for one change is not a figure for another.
  const forget = () => {
    setEstimate(null);
    setConfirmed(false);
  };
  const chooseKind = (next: FeeWaiverKindName) => {
    setKind(next);
    // Businesses have no tip fee (spec §2).
    if (next === 'business') setFee('withdrawal');
    forget();
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const start = String(data.get('start') ?? '');
    const end = String(data.get('end') ?? '');
    const reason = String(data.get('reason') ?? '').trim();
    const today = lagosToday();
    if (start && start < today) return setError(C.startPast);
    if (end && end < today) return setError(C.endPast);
    if (start && end && end < start) return setError(C.endBeforeStart);
    if (reason.length < 10) return setError(C.reasonShort);
    if (estimate && !confirmed) return setError(C.confirmMissing);
    setBusy(true);
    setError('');
    const answer = await setFeeWaiver({
      scope: 'kind',
      kind,
      fee,
      payer,
      ...(start ? { startsAt: startOfLagosDay(start) } : {}),
      ...(end ? { endsAt: endOfLagosDay(end) } : {}),
      reason,
      ...(payer === 'tipme' && estimate && confirmed
        ? { confirmCost: true as const, costEstimateMinor: estimate.minor }
        : {}),
    });
    setBusy(false);
    if (answer.kind !== 'refused') return onAnswered(answer);
    if (
      answer.code === 'FEE_WAIVER_CONFIRM_REQUIRED' &&
      answer.costEstimateMinor !== undefined
    ) {
      setEstimate({
        minor: answer.costEstimateMinor,
        moved: answer.reason === 'estimate_moved',
      });
      setConfirmed(false);
      return;
    }
    setError(
      answer.code === 'VALIDATION_FAILED' || answer.code === 'INVALID_INPUT'
        ? C.outOfBounds
        : refusalWords(answer),
    );
  };

  return (
    <dialog
      ref={dialog}
      className="ops-code-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        // Escape: closing is ours, so React's state and the dialog can't disagree.
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form className="settings-form" onSubmit={(e) => void send(e)} noValidate>
        <h2 id={`${id}-title`}>{C.dialogTitle}</h2>
        <div className="tm-field">
          <label htmlFor={`${id}-kind`}>{C.forLabel}</label>
          <select
            id={`${id}-kind`}
            className="tm-input"
            value={kind}
            onChange={(e) => chooseKind(e.target.value as FeeWaiverKindName)}
            autoFocus
          >
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {C.kinds[value]}
                {value === 'giving' ? ` ${C.notLive}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="tm-field">
          <label htmlFor={`${id}-fee`}>{C.feeLabel}</label>
          {kind === 'business' && (
            <p id={`${id}-fee-hint`} className="tm-hint">
              {C.businessTipNote}
            </p>
          )}
          <select
            id={`${id}-fee`}
            className="tm-input"
            value={fee}
            aria-describedby={
              kind === 'business' ? `${id}-fee-hint` : undefined
            }
            onChange={(e) => {
              setFee(e.target.value as FeeWaiverFeeName);
              forget();
            }}
          >
            {FEES.map((value) => (
              <option
                key={value}
                value={value}
                disabled={kind === 'business' && value === 'tip'}
              >
                {C.fees[value]}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="ops-picker">
          <legend>{C.payerLegend}</legend>
          {(
            [
              ['tipme', C.tipmePaysChoice, C.tipmePaysHint],
              ['account', C.normalChoice, C.normalHint],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="ops-radio">
              <input
                type="radio"
                name={`${id}-payer`}
                value={value}
                checked={payer === value}
                onChange={() => {
                  setPayer(value);
                  forget();
                }}
              />
              <span>
                <strong>{label}</strong>
                <span className="tm-hint">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <InputField
          id={`${id}-start`}
          name="start"
          type="date"
          label={C.startLabel}
          hint={C.startHint}
          min={lagosToday()}
        />
        <InputField
          id={`${id}-end`}
          name="end"
          type="date"
          label={C.endLabel}
          hint={C.endHint}
          min={lagosToday()}
        />
        <TextareaField
          id={`${id}-reason`}
          name="reason"
          label={C.reasonLabel}
          hint={C.reasonHint}
          maxLength={500}
        />
        {estimate && (
          <>
            <Slip dense tone="waiting" title={C.monthlyCostTitle}>
              {withAmount(
                estimate.moved ? C.estimateMoved : C.confirmCost,
                estimate.minor,
              )}
            </Slip>
            <label className="ops-recovery__confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />{' '}
              {withAmount(C.confirmBox, estimate.minor)}
            </label>
          </>
        )}
        {error && (
          <Slip dense tone="error" title="Not done">
            {error}
          </Slip>
        )}
        <div className="ops-actions">
          <Button
            variant="continue"
            type="submit"
            disabled={busy}
            aria-busy={busy}
          >
            {C.submit}
          </Button>
          <Button variant="quiet" disabled={busy} onClick={onClose}>
            {C.cancel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * "Who pays the fees" (spec 2026-11-23 §6): the kind-wide rule for each kind and fee, what waivers
 * cost this Lagos month (two figures, never added), the low-balance pause, and the change dialog.
 */
function WhoPays() {
  const id = useId();
  const [state, setState] = useState<OpsFeeWaivers | null>(null);
  const [failed, setFailed] = useState(false);
  const [changing, setChanging] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);

  const load = useCallback(async () => {
    const result = await loadFeeWaivers();
    if (!result.ok) return setFailed(true);
    setFailed(false);
    setState(result.data);
  }, []);
  useEffect(() => {
    void loadFeeWaivers().then((result) => {
      if (!result.ok) return setFailed(true);
      setState(result.data);
    });
  }, []);

  const answered = (answer: OpsAnswer<OpsFeeWaivers>) => {
    if (answer.kind === 'refused') return;
    setChanging(false);
    if (answer.kind === 'done') setState(answer.data);
    setOutcome(outcomeOf(answer, C.done, C.meanwhile));
  };

  const tipHead = (
    <>
      {C.fees.tip}
      {state?.tipWaiversPaused && ` · ${C.paused}`}
    </>
  );
  const tipLabel = state?.tipWaiversPaused
    ? `${C.fees.tip} · ${C.paused}`
    : C.fees.tip;
  return (
    <Card className="settings-section ops-section">
      <section aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`}>{C.title}</h2>
        <p className="tm-hint">{C.hint}</p>
        {failed ? (
          <LoadFailed dense title="Couldn’t load who pays" onRetry={load}>
            Your role may not include it, or the connection failed.
          </LoadFailed>
        ) : !state ? (
          <Skeleton label="Loading who pays the fees" />
        ) : (
          <>
            {state.tipWaiversPaused && (
              <Slip
                dense
                tone="waiting"
                title={C.pausedTitle}
                data-testid="fee-waivers-paused"
              >
                {C.pausedBody}
              </Slip>
            )}
            <div
              className="ops-table-wrap"
              role="region"
              aria-label="Fees by kind of account"
              tabIndex={0}
            >
              <table className="ops-table ops-table--stack">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">Kind of account</span>
                    </th>
                    <th scope="col">{tipHead}</th>
                    <th scope="col">{C.fees.withdrawal}</th>
                    <th scope="col">{C.monthCost}</th>
                  </tr>
                </thead>
                <tbody>
                  {KINDS.map((kind) => (
                    <tr key={kind}>
                      <th scope="row">
                        {C.kinds[kind]}
                        {!state.grid[kind].tip.live && (
                          <>
                            {' '}
                            <span className="tm-hint">{C.notLive}</span>
                          </>
                        )}
                      </th>
                      <td data-label={tipLabel}>
                        <CellWords
                          kind={kind}
                          fee="tip"
                          cell={state.grid[kind].tip}
                        />
                      </td>
                      <td data-label={C.fees.withdrawal}>
                        <CellWords
                          kind={kind}
                          fee="withdrawal"
                          cell={state.grid[kind].withdrawal}
                        />
                      </td>
                      <td data-label={C.monthCost}>
                        {state.grid[kind].tip.live ? (
                          <WaiverCost cost={state.monthCost[kind]} />
                        ) : (
                          C.noFee
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {outcome && <ActionOutcome outcome={outcome} />}
            {state.waitingRequestIds.length > 0 && !outcome && (
              <Slip dense tone="waiting" title="Waiting for a second person">
                {C.waiting(state.waitingRequestIds.length)}
              </Slip>
            )}
            <div className="ops-actions">
              <Button
                variant="secondary"
                aria-haspopup="dialog"
                onClick={() => {
                  setOutcome(null);
                  setChanging(true);
                }}
              >
                {C.change}
              </Button>
            </div>
            <p>
              <Link href="/ops/plan-fees/waivers">{C.seeAll}</Link>
            </p>
            {changing && (
              <ChangeWhoPays
                onClose={() => setChanging(false)}
                onAnswered={answered}
              />
            )}
          </>
        )}
      </section>
    </Card>
  );
}
