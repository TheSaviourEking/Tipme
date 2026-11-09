'use client';
import { useEffect, useId, useState } from 'react';
import type {
  BusinessDetail,
  BusinessNoteView,
  NoteReport,
} from '@tipme/contracts';
import { Button, Choice, EmptySlip, Skeleton, StateLine } from '@tipme/ui';
import {
  loadBusinessNotes,
  noteDate,
  reportBusinessNote,
  tagLabel,
  useInsightsView,
  weekText,
} from '@/lib/business/insights-api';
import { useBusinessRevision } from '@/lib/business/use-business-live';

const REASONS: { value: NoteReport['reason']; label: string }[] = [
  { value: 'abusive', label: 'Abusive or threatening' },
  { value: 'spam', label: 'Spam or advertising' },
  { value: 'other', label: 'Something else' },
];

function ReportForm({
  businessId,
  note,
  onReported,
  onCancel,
}: {
  businessId: string;
  note: BusinessNoteView;
  onReported: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState<NoteReport['reason']>('abusive');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <form
      className="business-note__report"
      aria-describedby={error ? `${id}-error` : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(false);
        void reportBusinessNote(businessId, note.tipId, reason).then(
          (result) => {
            setBusy(false);
            if (result.ok) onReported();
            else setError(true);
          },
        );
      }}
    >
      <fieldset>
        <legend>What’s wrong with this note?</legend>
        {REASONS.map((option) => (
          <Choice
            key={option.value}
            name={`${id}-reason`}
            value={option.value}
            checked={reason === option.value}
            onChange={() => setReason(option.value)}
          >
            {option.label}
          </Choice>
        ))}
      </fieldset>
      <p className="tm-hint">
        It disappears from your business’s notes, and TipMe reviews it
        privately.
      </p>
      {error && (
        <StateLine tone="error" id={`${id}-error`}>
          That didn’t work. Please try again.
        </StateLine>
      )}
      <div className="note-actions">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Send report
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Notes (PR B7): what customers wrote about people at the location that week, after moderation.
 * The date only, never a time; no customer's name. Reporting hides a note until TipMe reviews it.
 */
export function NotesCard({ business }: { business: BusinessDetail }) {
  const view = useInsightsView();
  const [loaded, setLoaded] = useState<{
    key: string;
    notes: BusinessNoteView[] | null;
  } | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  // The view the last report was made in: the line goes when the week or location changes.
  const [reportedIn, setReportedIn] = useState<string | null>(null);

  const ready = Boolean(view && view.businessId === business.id);
  const locationId = view?.locationId ?? '';
  const week = view?.week ?? '';
  const key = ready ? `${locationId}|${week}` : '';
  const revision = useBusinessRevision();
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void loadBusinessNotes(business.id, locationId, week).then((result) => {
      if (live)
        setLoaded({
          key: `${locationId}|${week}`,
          notes: result.ok ? result.data : null,
        });
    });
    return () => {
      live = false;
    };
  }, [business.id, ready, locationId, week, revision]);

  if (!ready || !view) return <Skeleton label="Loading notes" />;
  const notes = loaded?.key === key ? loaded.notes : undefined;
  if (notes === undefined) return <Skeleton label="Loading notes" />;
  if (notes === null)
    return (
      <StateLine tone="error">
        We couldn’t load the notes. Please try again later.
      </StateLine>
    );
  return (
    <div className="business-notes">
      {reportedIn === key && (
        <StateLine tone="status">Reported. TipMe will review it.</StateLine>
      )}
      {notes.length === 0 ? (
        <EmptySlip title="No notes this week.">
          <p>
            Notes customers write after tipping, {weekText(view.week)}, show
            here.
          </p>
        </EmptySlip>
      ) : (
        <ul className="business-notes__list">
          {notes.map((note) => (
            <li key={note.tipId} className="business-note">
              <p className="business-note__who">
                <strong>{note.shownName}</strong>
                {note.tags.length > 0 && (
                  <span> · {note.tags.map(tagLabel).join(', ')}</span>
                )}
              </p>
              {note.body && (
                <blockquote className="business-note__body">
                  “{note.body}”
                </blockquote>
              )}
              <p className="tm-hint business-note__date">
                {noteDate(note.date)}
              </p>
              {reporting === note.tipId ? (
                <ReportForm
                  businessId={business.id}
                  note={note}
                  onCancel={() => setReporting(null)}
                  onReported={() => {
                    setReporting(null);
                    setReportedIn(key);
                    setLoaded({
                      key,
                      notes: notes.filter(
                        (entry) => entry.tipId !== note.tipId,
                      ),
                    });
                  }}
                />
              ) : (
                <Button
                  variant="secondary"
                  aria-label={`Report ${note.shownName}’s note of ${noteDate(note.date)}`}
                  onClick={() => setReporting(note.tipId)}
                >
                  Report
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
