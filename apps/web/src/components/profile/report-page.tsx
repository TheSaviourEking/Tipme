'use client';
import { useId, useState, type FormEvent } from 'react';
import { Button, Notice, TextareaField } from '@tipme/ui';
import { reportPage } from '@/lib/api-client';

const reasons = [
  { value: 'impersonation', label: 'Pretending to be someone else' },
  { value: 'scam', label: 'A scam or misleading page' },
  { value: 'abusive', label: 'Abusive or hateful content' },
  { value: 'other', label: 'Something else' },
] as const;

/** A quiet way for anyone to tell TipMe a page is wrong; staff review every report. */
export function ReportPage({ handle }: { handle: string }) {
  const id = useId();
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState('');
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const reason = String(data.get('reason') ?? '');
    if (!reason) return setError('Choose what’s wrong with this page.');
    const details = String(data.get('details') ?? '').trim();
    setState('busy');
    setError('');
    const result = await reportPage(handle, {
      reason,
      ...(details ? { details } : {}),
    });
    if (result.ok) return setState('sent');
    setState('idle');
    setError(
      result.code === 'RATE_LIMITED'
        ? 'Too many reports from here. Please try again later.'
        : 'We couldn’t send that. Please try again.',
    );
  };
  if (state === 'sent')
    return (
      <p role="status" className="report-page__sent">
        Thank you. TipMe will look into this page.
      </p>
    );
  return (
    <details className="report-page">
      <summary>Report this page</summary>
      <form onSubmit={(e) => void send(e)} noValidate>
        <fieldset>
          <legend>What’s wrong?</legend>
          {reasons.map((option) => (
            <label key={option.value} className="tip-remember">
              <input type="radio" name="reason" value={option.value} />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
        <TextareaField
          id={`${id}-details`}
          name="details"
          label="Anything else we should know (optional)"
          maxLength={500}
          hint="Only TipMe staff read this. Please don’t include card or bank details."
        />
        {error && (
          <Notice tone="error" title="Not sent">
            {error}
          </Notice>
        )}
        <Button
          type="submit"
          variant="secondary"
          disabled={state === 'busy'}
          aria-busy={state === 'busy'}
        >
          Send report
        </Button>
      </form>
    </details>
  );
}
