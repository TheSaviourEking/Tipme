'use client';
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  NOTIFICATION_PREFS_CHANGED,
  type NotificationPrefsView,
} from '@tipme/contracts';
import { Button, Card, Notice } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';
import { SettingsChapter } from './section';

// Notifications (ScreenSettings).

type PrefKey = keyof NotificationPrefsView;

const EMAIL_LABELS = {
  tipEmails: 'Email me about each tip (when my email is verified)',
  weeklyReports: 'Tell me when my weekly report is ready',
  milestones: 'Tell me about milestones and rewards',
  guideEmails: 'Send me guides and suggestions for getting started',
} as const satisfies Partial<Record<PrefKey, string>>;

// The owner's words (3 Nov 2026), exactly.
const POPUP_LABELS = {
  hideTipDetailsInPopups: {
    label: 'Hide who tipped and how much in pop-ups',
    hint: 'For shared screens and shop counters. Your tips list still shows the details.',
  },
  tipSound: {
    label: 'Sound for new tips',
    hint: 'Plays once for a new paid tip while TipMe is in a background tab.',
  },
} as const satisfies Partial<Record<PrefKey, { label: string; hint: string }>>;

/**
 * One card's form over the shared preferences. It saves the whole set through the same PUT: its
 * own keys as edited, every other key as last saved, so an unsaved change in the other card is
 * never sent by this one.
 */
function PrefsForm<K extends PrefKey>({
  id,
  title,
  intro,
  keys,
  label,
  hint,
  saveLabel,
  saved,
  onSaved,
}: {
  id: string;
  title: string;
  intro?: string;
  keys: readonly K[];
  label: (key: K) => string;
  hint?: (key: K) => string;
  saveLabel: string;
  saved: NotificationPrefsView;
  onSaved: (prefs: NotificationPrefsView) => void;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState<Pick<NotificationPrefsView, K>>(
    () =>
      Object.fromEntries(keys.map((key) => [key, saved[key]])) as Pick<
        NotificationPrefsView,
        K
      >,
  );
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setDone(false);
    setError('');
    const result = await apiFetch<NotificationPrefsView>(
      '/v1/me/notification-preferences',
      { method: 'PUT', body: { ...saved, ...draft } },
    );
    setBusy(false);
    if (result.ok) {
      onSaved(result.data);
      setDone(true);
      // The bell reads the pop-up switches again (same tab).
      window.dispatchEvent(new Event(NOTIFICATION_PREFS_CHANGED));
    } else setError('We couldn’t save that. Please try again.');
  };
  return (
    <Card id={id} className="settings-section">
      <h3>{title}</h3>
      {intro && <p className="tm-hint">{intro}</p>}
      <form className="settings-form" onSubmit={save} noValidate>
        {keys.map((key) =>
          hint ? (
            // The hint stays out of the label, so the switch's name is just its label.
            <div key={key} className="tip-remember">
              <input
                id={`${fieldId}-${key}`}
                type="checkbox"
                checked={draft[key]}
                aria-describedby={`${fieldId}-${key}-hint`}
                onChange={(e) => {
                  setDraft({ ...draft, [key]: e.target.checked });
                  setDone(false);
                }}
              />
              <span>
                <label htmlFor={`${fieldId}-${key}`}>{label(key)}</label>
                <small id={`${fieldId}-${key}-hint`}>{hint(key)}</small>
              </span>
            </div>
          ) : (
            <label
              key={key}
              className="tip-remember"
              htmlFor={`${fieldId}-${key}`}
            >
              <input
                id={`${fieldId}-${key}`}
                type="checkbox"
                checked={draft[key]}
                onChange={(e) => {
                  setDraft({ ...draft, [key]: e.target.checked });
                  setDone(false);
                }}
              />
              <span>{label(key)}</span>
            </label>
          ),
        )}
        {error && (
          <Notice tone="error" title="Not saved">
            {error}
          </Notice>
        )}
        <p role="status" className="tm-hint">
          {done ? 'Saved.' : ''}
        </p>
        <Button type="submit" disabled={busy} aria-busy={busy}>
          {saveLabel}
        </Button>
      </form>
    </Card>
  );
}

/**
 * Notifications (ScreenSettings): the emails card (#emails, where unsubscribe pages link) and the
 * pop-ups and sound card (#popups). Sign-in codes and security warnings always go.
 */
export function NotificationsSection() {
  const [saved, setSaved] = useState<NotificationPrefsView | null>(null);
  useEffect(() => {
    void apiFetch<NotificationPrefsView>(
      '/v1/me/notification-preferences',
    ).then((result) => {
      if (result.ok) setSaved(result.data);
    });
  }, []);
  return (
    <SettingsChapter id="notifications">
      {/* An API older than PR-013 has no preferences: say nothing rather than show a broken form. */}
      {saved && (
        <>
          <PrefsForm
            id="emails"
            title="Emails"
            intro="You always see your tips in TipMe. These emails always reach you: sign-in codes, security warnings, changes to your account and payment account, and withdrawals."
            keys={Object.keys(EMAIL_LABELS) as (keyof typeof EMAIL_LABELS)[]}
            label={(key) => EMAIL_LABELS[key]}
            saveLabel="Save notifications"
            saved={saved}
            onSaved={setSaved}
          />
          <PrefsForm
            id="popups"
            title="Pop-ups and sound"
            keys={Object.keys(POPUP_LABELS) as (keyof typeof POPUP_LABELS)[]}
            label={(key) => POPUP_LABELS[key].label}
            hint={(key) => POPUP_LABELS[key].hint}
            saveLabel="Save pop-ups and sound"
            saved={saved}
            onSaved={setSaved}
          />
        </>
      )}
    </SettingsChapter>
  );
}
