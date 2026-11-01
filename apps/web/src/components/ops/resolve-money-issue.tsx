'use client';
import { useId, useState, type FormEvent } from 'react';
import { Button, Notice, TextareaField } from '@tipme/ui';
import { ISSUE_OUTCOME_CHOICES } from '@/lib/ops-client';

/** Resolving a money issue: how it was settled, and why. Neither changes a balance. */
export function ResolveMoneyIssue({
  takeover = false,
  onSubmit,
}: {
  /** Closing a reported takeover: it releases the freeze, so staff confirm their checks first. */
  takeover?: boolean;
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
    if (takeover && data.get('checked') !== 'on') {
      setError('Confirm you checked the bank and the sign-in.');
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
          {Object.entries(ISSUE_OUTCOME_CHOICES)
            .filter(([value]) => (value === 'account_secured') === takeover)
            .map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
        </select>
        <span className="tm-hint">
          Stored with your reason. It changes no balance.
        </span>
      </div>
      {takeover && (
        <>
          <Notice tone="error" title="This releases the freeze">
            The next withdrawal goes to the current bank, which may be the
            thief’s, and whoever is signed in stays signed in. Check them first:
            the current bank belongs to the real owner, any withdrawal waiting
            is theirs (if not, mark it failed), and sessions were ended.
          </Notice>
          <label className="tm-field">
            <input type="checkbox" name="checked" required /> I checked the
            current bank and the sign-in with the real owner.
          </label>
        </>
      )}
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
