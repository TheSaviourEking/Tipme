'use client';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ProfileReportReason } from '@tipme/contracts';
import { Button, ResultKey, StateLine, useKeyResult } from '@tipme/ui';
import { reportPage } from '@/lib/api-client';

const REASONS: { value: ProfileReportReason; label: string }[] = [
  { value: 'impersonation', label: 'Pretending to be someone else' },
  { value: 'scam', label: 'A scam or fraud' },
  { value: 'abusive', label: 'Abusive or hateful' },
  { value: 'other', label: 'Something else' },
];

/** "Report this page" (PR-013): a reason from a list, never free text. TipMe reviews it. */
export function ReportPage({ handle }: { handle: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ProfileReportReason>('impersonation');
  const [done, setDone] = useState(false);
  // A small refusal of one click: the Send key says it (Concept B), the reason is one plain line.
  const key = useKeyResult({ onRetry: () => void send() });
  const thanks = useRef<HTMLParagraphElement>(null);
  // The form disappears once sent: keyboard focus moves to the confirmation, not the page top.
  useEffect(() => {
    if (done) thanks.current?.focus();
  }, [done]);
  const send = async () => {
    if (key.pending) return;
    key.start();
    const result = await reportPage(handle, reason);
    if (result.ok) {
      key.clear();
      setDone(true);
    } else key.failed({ label: 'Not sent', retryLabel: 'Try again' });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };
  const failed = key.result?.kind === 'failed';
  if (done)
    return (
      <p
        ref={thanks}
        tabIndex={-1}
        role="status"
        className="tm-hint report-page"
      >
        Thank you. TipMe will review this page.
      </p>
    );
  if (!open)
    return (
      <p className="report-page">
        <Button variant="quiet" onClick={() => setOpen(true)}>
          Report this page
        </Button>
      </p>
    );
  return (
    <form className="settings-form report-page" onSubmit={submit}>
      <div className="tm-field">
        <label htmlFor={`${id}-reason`}>What’s wrong with this page?</label>
        <select
          id={`${id}-reason`}
          className="tm-input"
          value={reason}
          onChange={(e) => setReason(e.target.value as ProfileReportReason)}
        >
          {REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <p className="tm-hint">
        TipMe reviews every report. We don’t tell the page who reported it.
      </p>
      <StateLine tone="error">
        {failed ? 'We couldn’t send the report. Please try again.' : ''}
      </StateLine>
      <div className="ops-actions">
        <ResultKey type="submit" result={key.result} pending={key.pending}>
          Send report
        </ResultKey>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
