'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { OpsPagePricing } from '@tipme/contracts';
import { Button, Card, InputField, Notice, TextareaField } from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import { bpsToPercent, percentToBps } from '@/lib/fee-percent';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

const problem = (answer: { status: number; code: string; message?: string }) =>
  answer.code === 'VALIDATION_FAILED'
    ? 'Check the values: a reason of at least 10 characters is needed.'
    : refusalWords(answer);

/** A value and a written reason, sent together (every pricing change is audited). */
export function ValueWithReason({
  label,
  hint,
  submit,
  parse,
  onSubmit,
}: {
  label: string;
  hint: string;
  submit: string;
  parse: (raw: string) => number | null;
  onSubmit: (value: number, reason: string) => Promise<string | null>;
}) {
  const id = useId();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = parse(String(data.get('value') ?? ''));
    const reason = String(data.get('reason') ?? '').trim();
    if (value === null) return setError(`Check the ${label.toLowerCase()}.`);
    if (reason.length < 10)
      return setError('Please write a reason of at least 10 characters.');
    setBusy(true);
    setError('');
    const failed = await onSubmit(value, reason);
    setBusy(false);
    if (failed) setError(failed);
    else form.reset();
  };
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
        <Notice tone="error" title="Not done">
          {error}
        </Notice>
      )}
      <Button type="submit" disabled={busy} aria-busy={busy}>
        {submit}
      </Button>
    </form>
  );
}

/**
 * One page's pricing (ADR-0014): TipMe keeps the page's plan rate (Free 7%, Pro 5%, owner 12 Nov
 * 2026) unless staff set a lower share for this page; a deal at or above the plan rate is capped
 * there. Fee-free tips exist only when staff grant them. Nothing here is automatic.
 */
export function PagePricing({ profileId }: { profileId: string }) {
  const [pricing, setPricing] = useState<OpsPagePricing | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const base = `/v1/ops/pages/${profileId}`;

  useEffect(() => {
    let current = true;
    void opsFetch<OpsPagePricing>(`${base}/pricing`).then((result) => {
      if (current && result.ok) setPricing(result.data);
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
    <Card className="settings-section">
      <h2>Pricing</h2>
      <p>
        TipMe fee: <strong>{bpsToPercent(pricing.feeBps)}</strong>
        {pricing.customFeeBps === null || capped
          ? ` (${standard}, the plan’s rate)`
          : ' (set by staff for this page)'}
        , processing included.
        {capped &&
          ` A staff-set ${bpsToPercent(pricing.customFeeBps!)} is stored, but no page pays more than its plan’s rate.`}{' '}
        Fee-free tips left: <strong>{pricing.feeFreeRemaining}</strong>
      </p>
      <p className="tm-hint">
        Changes apply to new tips only; a price already shown to a supporter is
        kept. Nothing here is automatic.
      </p>
      {outcome && <ActionOutcome outcome={outcome} />}
      <ValueWithReason
        label="New TipMe fee (%)"
        hint={`For example 4 or 2.5. Only a fee below the plan’s rate (${bpsToPercent(pricing.planFeeBps)}) changes anything.`}
        submit="Set this page’s fee"
        parse={percentToBps}
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
        label="Fee-free tips to grant"
        hint="Whole number, 1 to 100. Each paid tip uses one."
        submit="Grant fee-free tips"
        parse={(raw) =>
          /^\d{1,3}$/.test(raw.trim()) && Number(raw) >= 1 && Number(raw) <= 100
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
    </Card>
  );
}
