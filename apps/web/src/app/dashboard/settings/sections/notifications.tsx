'use client';
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { NotificationPrefs } from '@tipme/contracts';
import { Button, Card, Notice } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

// Notifications (ScreenSettings).

const PREF_LABELS = {
  tipEmails: 'Email me about each tip (when my email is verified)',
  weeklyReports: 'Tell me when my weekly report is ready',
  milestones: 'Tell me about milestones and rewards',
  guideEmails: 'Send me guides and suggestions for getting started',
} as const;

/** Notification preferences (PR-013). Sign-in codes and security warnings always go. */
export function NotificationSettings() {
  const id = useId();
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void apiFetch<NotificationPrefs>('/v1/me/notification-preferences').then(
      (result) => {
        if (result.ok) setPrefs(result.data);
      },
    );
  }, []);
  // An API older than PR-013 has no preferences: say nothing rather than show a broken form.
  if (!prefs) return null;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError('');
    const result = await apiFetch<NotificationPrefs>(
      '/v1/me/notification-preferences',
      { method: 'PUT', body: prefs },
    );
    setBusy(false);
    if (result.ok) {
      setPrefs(result.data);
      setSaved(true);
    } else setError('We couldn’t save that. Please try again.');
  };
  return (
    <Card id="emails" className="settings-section">
      <h2>Notifications</h2>
      <p className="tm-hint">
        You always see your tips in TipMe. These emails always reach you:
        sign-in codes, security warnings, changes to your account and payment
        account, and withdrawals.
      </p>
      <form className="settings-form" onSubmit={save} noValidate>
        {(Object.keys(PREF_LABELS) as (keyof NotificationPrefs)[]).map(
          (key) => (
            <label key={key} className="tip-remember" htmlFor={`${id}-${key}`}>
              <input
                id={`${id}-${key}`}
                type="checkbox"
                checked={prefs[key]}
                onChange={(e) => {
                  setPrefs({ ...prefs, [key]: e.target.checked });
                  setSaved(false);
                }}
              />
              <span>{PREF_LABELS[key]}</span>
            </label>
          ),
        )}
        {error && (
          <Notice tone="error" title="Not saved">
            {error}
          </Notice>
        )}
        <p role="status" className="tm-hint">
          {saved ? 'Saved.' : ''}
        </p>
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Save notifications
        </Button>
      </form>
    </Card>
  );
}
