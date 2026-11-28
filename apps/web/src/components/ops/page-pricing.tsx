'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { OpsCardCosts, OpsPagePricing } from '@tipme/contracts';
import { Button, Card, InputField, Slip, TextareaField } from '@tipme/ui';
import { AccountFeeWaivers } from '@/components/ops/account-fee-waivers';
import { ReasonAction } from '@/components/ops/reason-action';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import type { CardCostFigures } from '@/lib/card-cost-view';
import { bpsToPercent, percentToBps } from '@/lib/fee-percent';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';
import {
  BELOW_FLOOR,
  RATE_FLOOR_BPS,
  pageRateBelowFloor,
  rateCardLine,
} from '@/lib/rate-floor';

const problem = (answer: { status: number; code: string; message?: string }) =>
  answer.code === 'VALIDATION_FAILED'
    ? 'Check the values: a reason of at least 10 characters is needed.'
    : refusalWords(answer);

/**
 * A value and a written reason, sent together (every pricing change is audited). Closed, it is one
 * button ending in "…" (the OpsShell board's Pattern 3), so a card has one action in view at a time.
 */
export function ValueWithReason({
  open: openLabel,
  label,
  hint,
  submit,
  parse,
  invalid,
  onSubmit,
}: {
  open: string;
  label: string;
  hint: string;
  submit: string;
  parse: (raw: string) => number | null;
  /** What to say when `parse` refuses; the default names the field. */
  invalid?: string;
  onSubmit: (value: number, reason: string) => Promise<string | null>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = parse(String(data.get('value') ?? ''));
    const reason = String(data.get('reason') ?? '').trim();
    if (value === null)
      return setError(invalid ?? `Check the ${label.toLowerCase()}.`);
    if (reason.length < 10)
      return setError('Please write a reason of at least 10 characters.');
    setBusy(true);
    setError('');
    const failed = await onSubmit(value, reason);
    setBusy(false);
    if (failed) setError(failed);
    else {
      form.reset();
      setOpen(false);
    }
  };
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {openLabel}
      </Button>
    );
  return (
    <form className="ops-reason" onSubmit={(e) => void send(e)} noValidate>
      <InputField id={`${id}-value`} name="value" label={label} hint={hint} />
      <TextareaField
        id={`${id}-reason`}
        name="reason"
        label="Reason"
        hint="Recorded in the audit log with your name and the time."
        maxLength={500}
      />
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
          {submit}
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
  );
}

/**
 * One page's pricing (ADR-0014): TipMe keeps the page's plan rate (the rates in Fees, Free 5% and Pro
 * 3% to start, owner 18 Nov 2026) unless staff set a lower share for this page; a deal at or above the plan rate is capped
 * there. Fee-free tips exist only when staff grant them. Nothing here is automatic. Below it, who
 * pays this page's tip and withdrawal fees (fee waivers, spec 2026-11-23 §6).
 */
export function PagePricing({ profileId }: { profileId: string }) {
  const [pricing, setPricing] = useState<OpsPagePricing | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  // The card cost in force, to say where card starts at this page's rate (staff without the fees
  // permission don't get it, and the line is left out).
  const [cardCost, setCardCost] = useState<CardCostFigures | null>(null);
  const base = `/v1/ops/pages/${profileId}`;

  useEffect(() => {
    let current = true;
    void opsFetch<OpsPagePricing>(`${base}/pricing`).then((result) => {
      if (current && result.ok) setPricing(result.data);
    });
    void opsFetch<OpsCardCosts>('/v1/ops/card-costs').then((result) => {
      if (current && result.ok) setCardCost(result.data.current);
    });
    return () => {
      current = false;
    };
  }, [base]);

  const act = async (path: string, body: unknown, message: string) => {
    const answer = await opsAct<OpsPagePricing>(`${base}/${path}`, {
      method: 'POST',
      body,
    });
    if (answer.kind === 'refused') {
      if (outcomeIsUnknown(answer)) {
        const again = await opsFetch<OpsPagePricing>(`${base}/pricing`);
        if (again.ok) setPricing(again.data);
      }
      return problem(answer);
    }
    if (answer.kind === 'done') setPricing(answer.data);
    setOutcome(outcomeOf(answer, message));
    return null;
  };

  if (!pricing) return null;
  const planName = pricing.plan === 'pro' ? 'Pro' : 'Free';
  const standard = `${planName}’s ${bpsToPercent(pricing.planFeeBps)}`;
  const capped =
    pricing.customFeeBps !== null && pricing.customFeeBps >= pricing.planFeeBps;
  return (
    <>
      <Card className="settings-section">
        <h2>Pricing</h2>
        <p>
          TipMe fee: <strong>{bpsToPercent(pricing.feeBps)}</strong>
          {pricing.customFeeBps === null || capped
            ? ` (${standard}, the plan’s rate)`
            : ' (set by staff for this page)'}
          , payment processing included.
          {capped &&
            ` A staff-set ${bpsToPercent(pricing.customFeeBps!)} is stored, but no page pays more than its plan’s rate.`}{' '}
          Fee-free tips left: <strong>{pricing.feeFreeRemaining}</strong>
        </p>
        {rateCardLine(pricing.feeBps, cardCost) && (
          <p data-testid="page-fee-card">
            {rateCardLine(pricing.feeBps, cardCost)}
          </p>
        )}
        {pageRateBelowFloor(pricing.customFeeBps) && (
          <Slip dense tone="waiting" title={BELOW_FLOOR}>
            This page’s stored {bpsToPercent(pricing.customFeeBps!)} was set
            before the floor. It stays until it is changed here; a new fee must
            be {bpsToPercent(RATE_FLOOR_BPS)} or more (or 0 for fee-free).
          </Slip>
        )}
        <p className="tm-hint">
          Changes apply to new tips only; a price already shown to a supporter
          is kept. Nothing here is automatic.
        </p>
        {outcome && <ActionOutcome outcome={outcome} />}
        <div className="ops-actions">
          <ValueWithReason
            open="Set this page’s fee…"
            label="New TipMe fee (%)"
            hint={`${bpsToPercent(RATE_FLOOR_BPS).replace('%', '')} or more, for example 4 or 2.5 (0 is fee-free). Only a fee below the plan’s rate (${bpsToPercent(pricing.planFeeBps)}) changes anything.`}
            submit="Set this page’s fee"
            parse={(raw) => {
              const bps = percentToBps(raw);
              return bps === 0 || (bps !== null && bps >= RATE_FLOOR_BPS)
                ? bps
                : null;
            }}
            invalid={`Write the fee as a percentage of ${bpsToPercent(RATE_FLOOR_BPS).replace('%', '')} or more, or 0 for fee-free.`}
            onSubmit={(bps, reason) =>
              act(
                'fee',
                { feeBps: bps, reason },
                `The fee is now ${bpsToPercent(bps)} for new tips.`,
              )
            }
          />
          {pricing.customFeeBps !== null && (
            <ReasonAction
              open="Return to the plan’s rate"
              field="Why return to the plan’s rate?"
              submit="Use the plan’s rate"
              onSubmit={(reason) =>
                act(
                  'fee',
                  { feeBps: null, reason },
                  `The plan’s rate (${standard}) applies to new tips.`,
                )
              }
            />
          )}
          <ValueWithReason
            open="Grant fee-free tips…"
            label="Fee-free tips to grant"
            hint="Whole number, 1 to 100. Each paid tip uses one."
            submit="Grant fee-free tips"
            parse={(raw) =>
              /^\d{1,3}$/.test(raw.trim()) &&
              Number(raw) >= 1 &&
              Number(raw) <= 100
                ? Number(raw)
                : null
            }
            onSubmit={(count, reason) =>
              act(
                'fee-free',
                { count, reason },
                `${count} fee-free ${count === 1 ? 'tip' : 'tips'} granted.`,
              )
            }
          />
        </div>
      </Card>
      <AccountFeeWaivers owner={{ profileId }} />
    </>
  );
}
