'use client';
import { useId, useState, type FormEvent } from 'react';
import { Button, Notice, TextareaField } from '@tipme/ui';

/**
 * A button that opens a short form asking for the written reason every admin change needs
 * (10–500 characters; it goes into the audit log).
 */
export function ReasonAction({
  open: openLabel,
  field,
  submit,
  onSubmit,
  variant = 'secondary',
  hint = 'Recorded in the audit log with your name and the time.',
}: {
  open: string;
  field: string;
  submit: string;
  onSubmit: (reason: string) => Promise<string | null>;
  variant?: 'primary' | 'secondary' | 'quiet';
  /** Who reads the text; say so plainly when it is not only staff. */
  hint?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(
      new FormData(event.currentTarget).get('reason') ?? '',
    ).trim();
    if (reason.length < 10) {
      setError('Please write at least 10 characters.');
      return;
    }
    setBusy(true);
    setError('');
    const problem = await onSubmit(reason);
    setBusy(false);
    if (problem) setError(problem);
    else setOpen(false);
  };
  if (!open)
    return (
      <Button variant={variant} onClick={() => setOpen(true)}>
        {openLabel}
      </Button>
    );
  return (
    <form className="ops-reason" onSubmit={(e) => void send(e)}>
      <TextareaField
        id={`${id}-reason`}
        name="reason"
        label={field}
        hint={hint}
        minLength={10}
        maxLength={500}
        required
        autoFocus
      />
      {error && (
        <Notice tone="error" title="Not done">
          {error}
        </Notice>
      )}
      <div className="ops-actions">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          {submit}
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
