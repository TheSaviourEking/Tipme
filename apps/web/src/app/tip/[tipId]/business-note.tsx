'use client';
import { useId, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  BUSINESS_NOTE_LIMIT,
  BUSINESS_NOTE_TAGS,
  cleanThanksLine,
  hasContactDetails,
  hasLink,
  type BusinessNoteTag,
} from '@tipme/contracts';
import { Button, StateLine, Surface, TextareaField } from '@tipme/ui';
import { sendBusinessNote } from '@/lib/business/notes-api';

/** Skipping hides the block for this receipt, in this tab only. */
export const noteSkipKey = (tipId: string) =>
  `tipme:business-note-skip:${tipId}`;

const noSubscription = () => () => undefined;
function wasSkipped(tipId: string): boolean {
  try {
    return sessionStorage.getItem(noteSkipKey(tipId)) === '1';
  } catch {
    // No session storage: the block simply shows.
    return false;
  }
}

const codePoints = (text: string) => Array.from(text).length;
const TEXT_REFUSED = 'Links, emails and phone numbers can’t be sent.';
const NOTHING = 'Choose what stood out, or write a few words.';

/**
 * PR B5, board screen 3: after a paid tip made at a business, an optional note about the person,
 * with one-tap positive tags and a few words. The receipt above never waits on it, and skipping
 * it is one tap. There are no ratings and nothing negative to choose.
 */
export function BusinessNote({
  tipId,
  token,
  person,
  business,
}: {
  tipId: string;
  token: string;
  person: string;
  business: string;
}) {
  const id = useId();
  const [tags, setTags] = useState<BusinessNoteTag[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  // Skipped earlier in this tab (session storage), or just now.
  const skippedBefore = useSyncExternalStore(
    noSubscription,
    () => wasSkipped(tipId),
    () => false,
  );
  const [skippedNow, setSkippedNow] = useState(false);
  const skipped = skippedBefore || skippedNow;
  const [error, setError] = useState<{
    field: 'tags' | 'body' | 'form';
    text: string;
  } | null>(null);

  if (skipped) return null;
  if (sent)
    return (
      <Surface
        material="paper"
        className="business-note business-note--sent"
        role="region"
        aria-label="Your note"
      >
        <StateLine tone="status">Sent. Thank you.</StateLine>
      </Surface>
    );

  const cleaned = cleanThanksLine(body);
  const count = codePoints(cleaned);
  const toggle = (tag: BusinessNoteTag) => {
    setError(null);
    setTags((current) =>
      current.includes(tag)
        ? current.filter((t) => t !== tag)
        : [...current, tag],
    );
  };
  const skip = () => {
    try {
      sessionStorage.setItem(noteSkipKey(tipId), '1');
    } catch {
      // Hidden for now all the same.
    }
    setSkippedNow(true);
  };
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (tags.length === 0 && cleaned === '') {
      setError({ field: 'tags', text: NOTHING });
      return;
    }
    if (count > BUSINESS_NOTE_LIMIT) {
      setError({
        field: 'body',
        text: `At most ${BUSINESS_NOTE_LIMIT} characters.`,
      });
      return;
    }
    if (cleaned !== '' && (hasLink(cleaned) || hasContactDetails(cleaned))) {
      setError({ field: 'body', text: TEXT_REFUSED });
      return;
    }
    setBusy(true);
    setError(null);
    const result = await sendBusinessNote(tipId, token, {
      tags,
      ...(cleaned ? { body: cleaned } : {}),
    });
    setBusy(false);
    if (result.ok) {
      setSent(true);
      return;
    }
    if (result.code === 'VALIDATION_FAILED' && result.fields?.includes('body'))
      setError({ field: 'body', text: TEXT_REFUSED });
    else if (result.code === 'NOTE_NOT_OPEN')
      setError({
        field: 'form',
        text: 'A note can’t be added to this tip any more. Your tip is unchanged.',
      });
    else if (result.code === 'RATE_LIMITED')
      setError({
        field: 'form',
        text: 'Too many notes from here just now. Try again later.',
      });
    else
      setError({
        field: 'form',
        text: 'Your note wasn’t sent. Check your connection and try again. Your tip is unchanged.',
      });
  };

  const tagsError = error?.field === 'tags' ? error.text : undefined;
  const bodyError = error?.field === 'body' ? error.text : undefined;
  return (
    <Surface
      material="paper"
      className="business-note"
      role="region"
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`}>Thanks for tipping {person}</h2>
      <p className="business-note__ask">Want to say why? (optional)</p>
      <form onSubmit={(event) => void send(event)} noValidate>
        <fieldset
          className="business-note__tags"
          aria-describedby={tagsError ? `${id}-tags-error` : undefined}
        >
          <legend>What stood out</legend>
          <div className="business-note__tag-row">
            {BUSINESS_NOTE_TAGS.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="business-note__tag"
                aria-pressed={tags.includes(tag.id)}
                onClick={() => toggle(tag.id)}
              >
                {tag.label}
              </button>
            ))}
          </div>
          {tagsError && (
            <p className="tm-field-error" id={`${id}-tags-error`} role="alert">
              {tagsError}
            </p>
          )}
        </fieldset>
        <TextareaField
          id={`${id}-body`}
          name="body"
          label="A few words (optional)"
          hint={`${count} of ${BUSINESS_NOTE_LIMIT}`}
          value={body}
          error={bodyError}
          onChange={(event) => {
            setBody(event.target.value);
            if (error?.field === 'body') setError(null);
          }}
          aria-describedby={`${id}-readers`}
        />
        <p className="tm-hint" id={`${id}-readers`}>
          {person} and {business} will read this. Please keep it kind.
        </p>
        <div className="business-note__actions">
          <Button type="submit" disabled={busy} aria-busy={busy}>
            Send note
          </Button>
          <Button variant="quiet" onClick={skip}>
            Skip
          </Button>
        </div>
        <StateLine tone="error">
          {error?.field === 'form' ? error.text : null}
        </StateLine>
      </form>
    </Surface>
  );
}
