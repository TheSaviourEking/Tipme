'use client';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import {
  THANKS_LINE_LIMIT,
  THANKS_STYLES,
  cleanThanksLine,
  firstNameOf,
  hasLink,
  shownThanks,
  type MyProfile,
  type ThanksStyle,
} from '@tipme/contracts';
import { Button, Card, Notice, TextareaField } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { ThanksSlip } from '@/components/thanks-slip';
import { apiFetch } from '@/lib/session-client';
import { SettingsChapter } from './section';

// Make it yours (ProCustomise board): what a page can shape about what supporters meet.

const STYLE_NAMES: Record<ThanksStyle, string> = {
  paper: 'Paper',
  violet: 'Violet',
  night: 'Night',
};
const LINE_ERROR = 'Keep it to 140 characters, with no links.';
const PRO_ERROR = 'Card styles and your signature are part of TipMe Pro.';

/** Code points, as the API and Postgres count them, so an emoji counts once. */
const lengthOf = (text: string) => Array.from(text).length;

/**
 * The thank-you line a supporter reads on their receipt right after paying. Free: the line. Pro:
 * also the card style and a signature. What the API resolved decides the plan; the web only
 * shows it. An older API sends no `thanks`, so there is no card.
 */
export function ThanksSettings({ title }: { title: string }) {
  const id = useId();
  const { profile, setProfile } = useRecipient();
  const stored = profile.thanks;
  const [line, setLine] = useState(stored?.line ?? '');
  const [style, setStyle] = useState<ThanksStyle>(stored?.style ?? 'paper');
  const [signed, setSigned] = useState(stored?.signed ?? false);
  const [error, setError] = useState('');
  // A refusal about the card as a whole (the page left Pro), not about the line.
  const [cardError, setCardError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  if (!stored) return null;
  const pro = profile.plan === 'pro';
  // A page that left Pro keeps its style and signature; they show again on Pro.
  const keptPro = !pro && (stored.style !== 'paper' || stored.signed);
  const firstName = firstNameOf(profile.displayName);
  const cleaned = cleanThanksLine(line);
  const slip = shownThanks({
    line: cleaned || null,
    style,
    signed,
    plan: profile.plan,
    displayName: profile.displayName,
  });
  const edited = () => {
    setSaved(false);
    setError('');
    setCardError('');
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    // The API checks the same rule; checking here keeps the answer next to the field at once.
    if (lengthOf(cleaned) > THANKS_LINE_LIMIT || hasLink(cleaned)) {
      setError(LINE_ERROR);
      field.current?.focus();
      return;
    }
    setError('');
    setCardError('');
    setBusy(true);
    const result = await apiFetch<MyProfile>('/v1/me/thanks', {
      method: 'PUT',
      body: pro
        ? { line: cleaned || null, style, signed }
        : { line: cleaned || null },
    });
    setBusy(false);
    if (result.ok) {
      setProfile(result.data);
      setLine(result.data.thanks?.line ?? '');
      setSaved(true);
      return;
    }
    if (result.code === 'THANKS_PRO_REQUIRED') {
      // The page left Pro while Settings was open: show it as it is now, so the next save sends
      // the line alone and works. What was chosen stays stored for when the page is Pro again.
      const fresh = await apiFetch<MyProfile>('/v1/me/profile');
      if (fresh.ok) setProfile(fresh.data);
      setCardError(PRO_ERROR);
      return;
    }
    setError(
      result.fields?.includes('line')
        ? LINE_ERROR
        : 'We couldn’t save. Please try again.',
    );
    field.current?.focus();
  };

  return (
    <Card id="thanks" className="settings-section miy-thanks">
      <h3>{title}</h3>
      <p className="tm-hint">
        A line every supporter reads right after paying, in your words.
      </p>
      <div className="miy-thanks__body">
        <form className="settings-form" onSubmit={save} noValidate>
          <TextareaField
            id={`${id}-line`}
            ref={field}
            label="Your thank-you line"
            value={line}
            onChange={(event) => {
              setLine(event.target.value);
              edited();
            }}
            placeholder="Thank you for backing my channel."
            hint={`${lengthOf(cleaned)} of ${THANKS_LINE_LIMIT}. Supporters read it on their receipt right after paying. No links.`}
            error={error || undefined}
          />
          {pro ? (
            <>
              <fieldset className="miy-styles">
                <legend>Card style</legend>
                {THANKS_STYLES.map((value) => (
                  <label
                    key={value}
                    className="miy-style"
                    htmlFor={`${id}-style-${value}`}
                  >
                    <input
                      id={`${id}-style-${value}`}
                      type="radio"
                      name={`${id}-style`}
                      value={value}
                      checked={style === value}
                      onChange={() => {
                        setStyle(value);
                        edited();
                      }}
                    />
                    <span className="miy-style__swatch" data-style={value} />
                    <span>{STYLE_NAMES[value]}</span>
                  </label>
                ))}
              </fieldset>
              <label className="tip-remember" htmlFor={`${id}-signed`}>
                <input
                  id={`${id}-signed`}
                  type="checkbox"
                  checked={signed}
                  onChange={(event) => {
                    setSigned(event.target.checked);
                    edited();
                  }}
                />
                <span>Sign it “{firstName}”</span>
              </label>
            </>
          ) : (
            <>
              <p className="tm-hint">
                {PRO_ERROR} <Link href="#plan">See Plan</Link>
              </p>
              {keptPro && (
                <p className="tm-hint">
                  Your card style and signature are kept for when your page is
                  Pro again.
                </p>
              )}
            </>
          )}
          {cardError && (
            <Notice tone="error" title="Not saved">
              {cardError} Your page is on the Free plan now, so save again to
              keep your line.
            </Notice>
          )}
          <Button type="submit" disabled={busy} aria-busy={busy}>
            Save thank-you
          </Button>
          <p role="status" className="settings-saved">
            {saved ? 'Saved' : ''}
          </p>
        </form>
        <aside className="miy-receipt" aria-labelledby={`${id}-receipt`}>
          <p id={`${id}-receipt`} className="miy-receipt__label">
            The supporter’s receipt
          </p>
          <p className="miy-receipt__heading">
            {profile.displayName} got your tip.
          </p>
          {slip ? (
            <ThanksSlip slip={slip} />
          ) : (
            <p className="miy-receipt__empty">
              Without a line, the receipt shows only this heading.
            </p>
          )}
        </aside>
      </div>
    </Card>
  );
}

/** What already makes a page its own, elsewhere in TipMe. No controls and no price here. */
export function AlreadyYours({ title }: { title: string }) {
  return (
    <Card id="already-yours" className="settings-section">
      <h3>{title}</h3>
      <ul className="settings-list">
        <li>
          <Link href="#cover">Your cover</Link>: a design in your colour, your
          own photo, or a cover that moves. Free has three animated covers that
          play once; Pro adds every one, in any colour, with a slow loop.
        </li>
        <li>
          <Link href="/dashboard/qr">QR designs and print formats</Link>: the
          standard looks on Free, and more designs and formats on Pro.
        </li>
        <li>
          <Link href="#tip-amounts">Your tip amounts</Link>: the amounts on your
          page, the smallest tip and the one your page starts on, on Pro.
        </li>
      </ul>
    </Card>
  );
}

type Part = {
  id: string;
  title: string;
  Card: (props: { title: string }) => JSX.Element | null;
  needs?: 'pro';
};

/*
 * The chapter's parts, in order. Slots for later, so nothing else in the chapter changes:
 * - PR D adds { id: 'colour', title: 'Your colour', Card: AccentSettings, needs: 'pro' } and
 *   { id: 'pinned', title: 'A pinned note', Card: PinnedNoteSettings, needs: 'pro' } after 'thanks'.
 * - "Tip sound" and "When a tip lands" go between 'pinned' and 'more'. Live updates puts the
 *   "Sound for new tips" switch in Notifications; when the picker lands, decide whether it stays
 *   there (the card links to it) or moves here, so it never appears twice. The picker needs
 *   profiles.tip_sound_choice text NULL, and celebrations profiles.tip_celebration text NULL; a
 *   Pro-only choice reads as the Free default on Free.
 * - The animated cover is in AlreadyYours, so 'more' has the board's title.
 */
export const MAKE_IT_YOURS_PARTS: readonly Part[] = [
  { id: 'thanks', title: 'Your thank-you', Card: ThanksSettings },
  {
    id: 'more',
    title: 'Covers that move, QR codes that are yours',
    Card: AlreadyYours,
  },
];

export function MakeItYoursSection() {
  return (
    <SettingsChapter id="yours">
      {MAKE_IT_YOURS_PARTS.map(({ id, title, Card: PartCard }) => (
        <PartCard key={id} title={title} />
      ))}
    </SettingsChapter>
  );
}
