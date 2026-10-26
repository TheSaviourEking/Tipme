'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { OpsPagePricing } from '@tipme/contracts';
import { Button, Card, InputField, Notice, TextareaField } from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import { bpsToPercent, percentToBps } from '@/lib/fee-percent';
import { apiFetch } from '@/lib/session-client';

const STANDARD_BPS = 1000;

const problem = (code: string) =>
  code === 'FORBIDDEN'
    ? 'Your role can’t do that.'
    : code === 'VALIDATION_FAILED'
      ? 'Check the values: a reason of at least 10 characters is needed.'
      : 'That didn’t work. Please try again.';

/** A value and a written reason, sent together (every pricing change is audited). */
function ValueWithReason({
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
 * One page's pricing (ADR-0014): TipMe keeps 10% unless staff set another share for this page,
 * and fee-free tips exist only when staff grant them. Nothing here is automatic.
 */
export function PagePricing({ profileId }: { profileId: string }) {
  const [pricing, setPricing] = useState<OpsPagePricing | null>(null);
  const [done, setDone] = useState('');
  const base = `/v1/ops/pages/${profileId}`;

  useEffect(() => {
    let current = true;
    void apiFetch<OpsPagePricing>(`${base}/pricing`).then((result) => {
      if (current && result.ok) setPricing(result.data);
    });
    return () => {
      current = false;
    };
  }, [base]);

  const act = async (path: string, body: unknown, message: string) => {
    const result = await apiFetch<OpsPagePricing>(`${base}/${path}`, {
      method: 'POST',
      body,
    });
    if (!result.ok) return problem(result.code);
    setPricing(result.data);
    setDone(message);
    return null;
  };

  if (!pricing) return null;
  const fee = pricing.customFeeBps ?? STANDARD_BPS;
  return (
    <Card className="settings-section">
      <h2>Pricing</h2>
      <p>
        TipMe fee: <strong>{bpsToPercent(fee)}</strong>
        {pricing.customFeeBps === null
          ? ' (standard)'
          : ' (set by staff for this page)'}
        , processing included. Fee-free tips left:{' '}
        <strong>{pricing.feeFreeRemaining}</strong>
      </p>
      <p className="tm-hint">
        Changes apply to new tips only; a price already shown to a supporter is
        kept. Nothing here is automatic.
      </p>
      {done && (
        <Notice tone="success" title="Done">
          {done}
        </Notice>
      )}
      <ValueWithReason
        label="New TipMe fee (%)"
        hint="For example 8 or 7.5. Use 10 for the standard fee."
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
          open="Return to the standard 10%"
          field="Why return to the standard fee?"
          submit="Use the standard fee"
          onSubmit={(reason) =>
            act(
              'fee',
              { feeBps: null, reason },
              'The standard 10% applies to new tips.',
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
