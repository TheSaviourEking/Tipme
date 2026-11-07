'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  BUSINESS_NOTE_TAGS,
  type MyMembership,
  type NoteReport,
  type WorkNoteView,
} from '@tipme/contracts';
import { Button, Skeleton, StateLine } from '@tipme/ui';
import { loadMyNotes, reportMyNote } from '@/lib/business/notes-api';
import { useBusinessLive } from '@/lib/business/use-business-live';

const TAG_LABEL = Object.fromEntries(
  BUSINESS_NOTE_TAGS.map((tag) => [tag.id, tag.label]),
) as Record<string, string>;
const REASONS: { value: NoteReport['reason']; label: string }[] = [
  { value: 'abusive', label: 'Abusive or threatening' },
  { value: 'spam', label: 'Spam or advertising' },
  { value: 'other', label: 'Something else' },
];

const dateWords = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });

function ReportNote({
  note,
  onReported,
}: {
  note: WorkNoteView;
  onReported: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<NoteReport['reason']>('abusive');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Report this note
      </Button>
    );
  return (
    <form
      className="work-note__report"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        void reportMyNote(note.tipId, reason).then((result) => {
          setBusy(false);
          if (result.ok) onReported();
          else setError('That didn’t work. Please try again.');
        });
      }}
    >
      <fieldset>
        <legend>What’s wrong with it?</legend>
        {REASONS.map((option) => (
          <label key={option.value} className="tm-choice">
            <input
              type="radio"
              name={`${id}-reason`}
              value={option.value}
              checked={reason === option.value}
              onChange={() => setReason(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      <p className="tm-hint">
        {note.business} stops seeing it at once, and TipMe looks at it
        privately.
      </p>
      <div className="work-note__actions">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Send report
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <StateLine tone="error">{error || null}</StateLine>
    </form>
  );
}

/**
 * PR B5: what supporters wrote about this person at this workplace, newest first. They may report
 * one: the business stops seeing it at once, until TipMe staff look at it.
 */
export function NotesCard({ membership }: { membership: MyMembership }) {
  const [notes, setNotes] = useState<WorkNoteView[] | null | undefined>(
    undefined,
  );
  const [said, setSaid] = useState('');
  const load = useCallback(() => loadMyNotes().then(setNotes), []);
  useEffect(() => {
    void load();
  }, [load]);
  useBusinessLive(() => void load());

  if (notes === undefined) return <Skeleton label="Loading your notes" />;
  if (notes === null)
    return (
      <StateLine tone="error">
        Your notes couldn’t be loaded. Refresh to try again.
      </StateLine>
    );
  const mine = notes.filter((note) => note.memberId === membership.memberId);
  return (
    <div className="work-notes">
      <StateLine tone="status">{said || null}</StateLine>
      {mine.length === 0 ? (
        <p className="tm-hint">
          No notes yet. When a supporter leaves one after tipping you here, it
          shows here.
        </p>
      ) : (
        <ul className="work-notes__list">
          {mine.map((note) => (
            <li key={note.tipId} className="work-note">
              <p className="work-note__date">{dateWords(note.date)}</p>
              {note.removed ? (
                <p className="work-note__removed">Removed by TipMe</p>
              ) : (
                <>
                  {note.tags.length > 0 && (
                    <ul className="work-note__tags" aria-label="What stood out">
                      {note.tags.map((tag) => (
                        <li key={tag}>{TAG_LABEL[tag] ?? tag}</li>
                      ))}
                    </ul>
                  )}
                  {note.body && (
                    <blockquote className="work-note__body">
                      {note.body}
                    </blockquote>
                  )}
                </>
              )}
              {note.reported && (
                <p className="tm-hint">
                  Reported. Hidden from {note.business} until TipMe looks at it.
                </p>
              )}
              {note.canReport && (
                <ReportNote
                  note={note}
                  onReported={() => {
                    setSaid(
                      `Reported. ${note.business} no longer sees that note.`,
                    );
                    void load();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
