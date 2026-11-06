'use client';
import { useId, useState, type FormEvent } from 'react';
import {
  TAKE_BACK_CATEGORIES,
  TAKE_BACK_CATEGORY_WORDS,
  TAKE_BACK_WHY,
  type OpsPage,
  type OpsTakeBack,
  type OpsTakeBackFacts,
  type TakeBackCategory,
  type TakeBackKind,
} from '@tipme/contracts';
import { Button, Notice } from '@tipme/ui';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';
import { opsAct } from '@/lib/ops-staff-api';

const yes = (value: boolean) => (value ? 'Yes' : 'No');

/** Ordinary notice is 7 to 30 days; the other categories 1 to 7 (no-notice is PR 3). */
const noticeRange = (category: TakeBackCategory) =>
  category === 'ordinary' ? { min: 7, max: 30 } : { min: 1, max: 7 };

export type TakeBackAnswer =
  | { kind: 'waiting' }
  | { kind: 'done'; actedAlone: boolean; takeBack: OpsTakeBack | null };

/**
 * Asks to take a username back from a page (serious action `username.take_back`): the category,
 * the notice, the staff-only reason, and the email the person will get. The server checks
 * everything again, and waits for a second person when one exists.
 */
export function TakeBackForm({
  name,
  kind,
  page,
  facts,
  onDone,
}: {
  name: string;
  kind: TakeBackKind;
  page: OpsPage;
  facts: OpsTakeBackFacts | undefined;
  onDone: (answer: TakeBackAnswer) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<TakeBackCategory>('ordinary');
  const [days, setDays] = useState(7);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const range = noticeRange(category);

  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Take back this username…
      </Button>
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const result = await opsAct<{
      takeBack?: OpsTakeBack;
      actedAlone?: true;
    }>(`/v1/ops/usernames/${encodeURIComponent(name)}/take-back`, {
      method: 'POST',
      body: {
        profileId: page.profileId,
        category,
        noticeDays: days,
        reason,
      },
    });
    setBusy(false);
    if (result.kind === 'refused') {
      setError(
        outcomeIsUnknown(result)
          ? 'We can’t say whether it went through. Reload and check before trying again.'
          : refusalWords(result, { handle: page.handle }),
      );
      return;
    }
    setOpen(false);
    onDone(
      result.kind === 'waiting'
        ? { kind: 'waiting' }
        : {
            kind: 'done',
            actedAlone: result.actedAlone,
            takeBack: result.data.takeBack ?? null,
          },
    );
  };

  return (
    <form
      className="settings-form"
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => void submit(e)}
    >
      <h4 id={`${id}-title`}>Take @{name} back</h4>
      {facts && (
        <dl className="ops-facts">
          <div>
            <dt>Plan</dt>
            <dd>{facts.plan === 'pro' ? 'Pro' : 'Free'}</dd>
          </div>
          <div>
            <dt>Live</dt>
            <dd>{yes(facts.pageState === 'live')}</dd>
          </div>
          <div>
            <dt>Has a balance</dt>
            <dd>{yes(facts.hasBalance)}</dd>
          </div>
          <div>
            <dt>Withdrawal in flight</dt>
            <dd>{yes(facts.withdrawalInFlight)}</dd>
          </div>
          <div>
            <dt>Verified address on file</dt>
            <dd>{yes(facts.verifiedEmail)}</dd>
          </div>
        </dl>
      )}
      {facts?.liveCheckoutListed && (
        <Notice tone="error" title="Listed for live checkout">
          This page is listed in LIVE_CHECKOUT_HANDLES. Update it to the new
          username, or it loses live checkout.
        </Notice>
      )}
      <fieldset>
        <legend>Category</legend>
        {TAKE_BACK_CATEGORIES.map((each) => (
          <label key={each} className="tm-radio">
            <input
              type="radio"
              name={`${id}-category`}
              value={each}
              checked={category === each}
              onChange={() => {
                setCategory(each);
                setDays(7);
              }}
            />{' '}
            {TAKE_BACK_CATEGORY_WORDS[each]}
          </label>
        ))}
      </fieldset>
      <div className="tm-field">
        <label htmlFor={`${id}-days`}>Days of notice</label>
        <input
          id={`${id}-days`}
          className="tm-input"
          type="number"
          inputMode="numeric"
          min={range.min}
          max={range.max}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        />
        <p className="tm-hint">
          {category === 'ordinary'
            ? 'Ordinary take-backs give 7 to 30 days.'
            : 'Up to 7 days, at least 1.'}{' '}
          The clock starts once the email is sent or the person sees the notice
          on their dashboard. With neither, it goes ahead after 14 days.
        </p>
      </div>
      <div className="tm-field">
        <label htmlFor={`${id}-reason`}>Internal reason</label>
        <textarea
          id={`${id}-reason`}
          className="tm-input"
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby={`${id}-reason-hint`}
        />
        <p id={`${id}-reason-hint`} className="tm-hint">
          Staff only. The user never sees this.
        </p>
      </div>
      <div className="ops-facts">
        <p>
          <strong>What they’ll read:</strong>{' '}
          {kind === 'current'
            ? `TipMe needs the username @${name} back. ${TAKE_BACK_WHY[category]}`
            : `Links and QR codes that still use your old username @${name} will stop working. ${TAKE_BACK_WHY[category]}`}
        </p>
      </div>
      {error && (
        <p role="alert" className="tm-field-error">
          {error}
        </p>
      )}
      <div className="ops-actions">
        <Button type="submit" aria-busy={busy}>
          Ask to take it back
        </Button>
        <Button variant="quiet" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
