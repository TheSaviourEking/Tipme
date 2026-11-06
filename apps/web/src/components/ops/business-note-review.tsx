'use client';
import { useState } from 'react';
import {
  BUSINESS_NOTE_TAGS,
  type NoteReview,
  type OpsBusinessNote,
} from '@tipme/contracts';
import { StateLine } from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import { opsFetch } from '@/lib/ops-staff-api';

const TAG_LABEL = Object.fromEntries(
  BUSINESS_NOTE_TAGS.map((tag) => [tag.id, tag.label]),
) as Record<string, string>;
const REASON_LABEL: Record<OpsBusinessNote['report']['reason'], string> = {
  abusive: 'Abusive or threatening',
  spam: 'Spam or advertising',
  other: 'Something else',
};
const BY_LABEL: Record<OpsBusinessNote['report']['reportedBy'], string> = {
  member: 'The person it is about',
  manager: 'A manager at the business',
};
const OUTCOME_LABEL: Record<NoteReview['outcome'], string> = {
  restored: 'Restored: the business sees it again.',
  removed:
    'Removed: the business never sees it again; the person sees “Removed by TipMe”.',
};

const refused = (result: { code: string }) =>
  result.code === 'FRESH_CODE_REQUIRED'
    ? 'Enter a fresh authenticator code first.'
    : result.code === 'ISSUE_RESOLVED'
      ? 'Someone has already decided this note.'
      : result.code === 'FORBIDDEN'
        ? 'Your role can’t do this.'
        : 'That didn’t work. Please try again.';

/**
 * PR B5: a reported note about someone at a business. Its words show only after a reasoned,
 * audited reveal; then staff restore it for the business or remove it, once, with a reason.
 */
export function BusinessNoteReview({
  tipId,
  canReveal,
  canDecide,
  onDecided,
}: {
  tipId: string;
  canReveal: boolean;
  canDecide: boolean;
  onDecided: () => Promise<void> | void;
}) {
  const [note, setNote] = useState<OpsBusinessNote | null>(null);
  const [said, setSaid] = useState('');
  const decide = async (outcome: NoteReview['outcome'], reason: string) => {
    const result = await opsFetch<{ outcome: NoteReview['outcome'] }>(
      `/v1/ops/business-notes/${encodeURIComponent(tipId)}/review`,
      { method: 'POST', body: { outcome, reason } },
    );
    if (!result.ok) return refused(result);
    setNote((current) =>
      current
        ? {
            ...current,
            report: {
              ...current.report,
              outcome,
              reviewedAt: new Date().toISOString(),
            },
          }
        : current,
    );
    setSaid(OUTCOME_LABEL[outcome]);
    await onDecided();
    return null;
  };

  if (!note)
    return (
      <div className="business-note-review">
        <p className="tm-hint">
          The note’s words are hidden. Reading them needs a reason and is
          recorded. It stays hidden from the business until you decide.
        </p>
        {canReveal ? (
          <ReasonAction
            open="Reveal the note"
            field="Why do you need to read it?"
            submit="Reveal"
            onSubmit={async (reason) => {
              const result = await opsFetch<OpsBusinessNote>(
                `/v1/ops/business-notes/${encodeURIComponent(tipId)}/reveal`,
                { method: 'POST', body: { reason } },
              );
              if (!result.ok) return refused(result);
              setNote(result.data);
              return null;
            }}
          />
        ) : (
          <p className="tm-hint">Your role can’t read it.</p>
        )}
      </div>
    );

  const decided = note.report.outcome;
  return (
    <div className="business-note-review">
      <dl className="ops-facts">
        <div>
          <dt>About</dt>
          <dd>
            {note.shownName} at {note.business} · {note.location}
          </dd>
        </div>
        <div>
          <dt>Written</dt>
          <dd>{note.date}</dd>
        </div>
        <div>
          <dt>Tags</dt>
          <dd>
            {note.tags.length
              ? note.tags.map((tag) => TAG_LABEL[tag] ?? tag).join(', ')
              : 'None'}
          </dd>
        </div>
        <div>
          <dt>Words</dt>
          <dd>{note.body ?? 'None'}</dd>
        </div>
        <div>
          <dt>Reported by</dt>
          <dd>
            {BY_LABEL[note.report.reportedBy]} ·{' '}
            {REASON_LABEL[note.report.reason]}
          </dd>
        </div>
        {decided && (
          <div>
            <dt>Decided</dt>
            <dd>{OUTCOME_LABEL[decided]}</dd>
          </div>
        )}
      </dl>
      <StateLine tone="status">{said || null}</StateLine>
      {!decided && canDecide && (
        <div className="ops-actions">
          <ReasonAction
            open="Restore for the business…"
            field="Why restore it?"
            submit="Restore note"
            onSubmit={(reason) => decide('restored', reason)}
          />
          <ReasonAction
            open="Remove it…"
            field="Why remove it?"
            submit="Remove note"
            onSubmit={(reason) => decide('removed', reason)}
          />
        </div>
      )}
    </div>
  );
}
