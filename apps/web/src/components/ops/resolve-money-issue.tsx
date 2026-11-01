'use client';
import { useId, useState, type FormEvent } from 'react';
import { Button, Notice, TextareaField } from '@tipme/ui';
import { ISSUE_OUTCOME_LABELS } from '@/lib/ops-client';

/** Resolving a money issue: how it was settled, and why. Neither changes a balance. */
export function ResolveMoneyIssue({
  onSubmit,
}: {
  onSubmit: (reason: string, outcome: string) => Promise<string | null>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const reason = String(data.get('reason') ?? '').trim();
    const outcome = String(data.get('outcome') ?? '');
    if (!outcome) {
      setError('Choose how it was settled.');
      return;
    }
    if (reason.length < 10) {
      setError('Please write at least 10 characters.');
      return;
    }
    setBusy(true);
    setError('');
    const problem = await onSubmit(reason, outcome);
    setBusy(false);
    if (problem) setError(problem);
    else setOpen(false);
  };
  if (!open)
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        Resolve…
      </Button>
    );
  return (
    <form className="ops-reason" onSubmit={(e) => void send(e)}>
      <div className="tm-field">
        <label htmlFor={`${id}-outcome`}>How was it settled?</label>
        <select
          id={`${id}-outcome`}
          className="tm-input"
          name="outcome"
          defaultValue=""
          required
        >
          <option value="" disabled>
            Choose an outcome
          </option>
          {Object.entries(ISSUE_OUTCOME_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <span className="tm-hint">
          Stored with your reason. It changes no balance.
        </span>
      </div>
      <TextareaField
        id={`${id}-reason`}
        name="reason"
        label="How was it resolved?"
        hint="Recorded in the audit log with your name and the time."
        minLength={10}
        maxLength={500}
        required
      />
      {error && (
        <Notice tone="error" title="Not done">
          {error}
        </Notice>
      )}
      <div className="ops-actions">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Resolve issue
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
