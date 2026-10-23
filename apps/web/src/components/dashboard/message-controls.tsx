'use client';
import { useId, useState } from 'react';
import { Button, Notice } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

/**
 * A recipient's controls for a supporter's message (PR-011, FR-010): hide it from their own
 * views, or report it to TipMe (which also hides it). TipMe staff review reports privately.
 */
export function MessageControls({
  tipId,
  onChanged,
}: {
  tipId: string;
  onChanged: () => void;
}) {
  const id = useId();
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState('abusive');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (action: 'hide' | 'report') => {
    setBusy(true);
    setError('');
    const result = await apiFetch(
      `/v1/me/tips/${encodeURIComponent(tipId)}/message/${action}`,
      {
        method: 'POST',
        body: action === 'report' ? { reason } : {},
      },
    );
    setBusy(false);
    if (result.ok) onChanged();
    else setError('That didn’t work. Please try again.');
  };
  return (
    <div className="message-controls">
      {error && (
        <Notice tone="error" title="Not done">
          {error}
        </Notice>
      )}
      {reporting ? (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void send('report');
          }}
        >
          <div className="tm-field">
            <label htmlFor={`${id}-reason`}>What’s wrong with it?</label>
            <select
              id={`${id}-reason`}
              className="tm-input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            >
              <option value="abusive">Abusive or threatening</option>
              <option value="spam">Spam or advertising</option>
              <option value="other">Something else</option>
            </select>
          </div>
          <p className="tm-hint">
            It disappears from your dashboard, and TipMe reviews it privately.
          </p>
          <div className="ops-actions">
            <Button type="submit" disabled={busy} aria-busy={busy}>
              Report message
            </Button>
            <Button variant="quiet" onClick={() => setReporting(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="ops-actions">
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => void send('hide')}
          >
            Hide message
          </Button>
          <Button variant="quiet" onClick={() => setReporting(true)}>
            Report message…
          </Button>
        </div>
      )}
    </div>
  );
}
