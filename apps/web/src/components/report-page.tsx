'use client';
import { useId, useState, type FormEvent } from 'react';
import type { ProfileReportReason } from '@tipme/contracts';
import { Button, Notice } from '@tipme/ui';
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
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailed(false);
    const result = await reportPage(handle, reason);
    setBusy(false);
    if (result.ok) setDone(true);
    else setFailed(true);
  };
  if (done)
    return (
      <p role="status" className="tm-hint report-page">
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
    <form className="settings-form report-page" onSubmit={(e) => void send(e)}>
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
      {failed && (
        <Notice tone="error" title="Not sent">
          We couldn’t send the report. Please try again.
        </Notice>
      )}
      <div className="ops-actions">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Send report
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
