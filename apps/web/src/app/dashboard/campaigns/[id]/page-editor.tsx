'use client';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import {
  CAMPAIGN_DESCRIPTION_MAX,
  CAMPAIGN_HEADLINE_MAX,
  COVER_ANIMATIONS,
  COVER_COLOURS,
  COVER_DESIGNS,
  campaignPageSchema,
  type CampaignDetail,
  type CampaignPageSettings,
  type CoverDesignChoice,
  type ResolvedCover,
} from '@tipme/contracts';
import { Button, InputField, TextareaField } from '@tipme/ui';
import { useRecipient } from '@/components/account/recipient-context';
import { ProfileCover } from '@/components/profile/cover';
import { campaignLink } from '@/lib/campaign-link';
import {
  choiceBody,
  draftFromChoice,
  draftPreview,
  takesColours,
  type CoverDraft,
} from '@/lib/cover-choice';
import { naira } from '@/lib/money';
import { readPrice } from '@/lib/pro-buy';
import { apiFetch } from '@/lib/session-client';
import { useOrigin } from '../campaigns-view';
import { CampaignPagePreview } from './page-preview';
import { counterText, coverSummary } from './page-editor-text';

const NO_PAGE: CampaignPageSettings = {
  on: false,
  headline: null,
  description: null,
  cover: null,
};

/** A campaign's cover choice in the shape the cover chooser opens from (no photo on campaigns). */
const asSaved = (choice: CoverDesignChoice) => ({
  ...choice,
  colour: choice.colour ?? null,
  hasPhoto: false,
});

/** The cover a draft shows: null is "Same as page". */
function coverOf(
  choice: CoverDesignChoice | null,
  handle: string,
): ResolvedCover | null {
  if (!choice) return null;
  return draftPreview(draftFromChoice(asSaved(choice)), handle, 'pro');
}

/** Covers for a campaign: "Same as page", the animated covers, then the designs. All Pro's. */
function CoverPicker({
  value,
  onChange,
  handle,
  disabled,
}: {
  value: CoverDesignChoice | null;
  onChange: (next: CoverDesignChoice | null) => void;
  handle: string;
  disabled: boolean;
}) {
  const id = useId();
  const draft: CoverDraft = value
    ? draftFromChoice(asSaved(value))
    : { design: null, colour: 'neutral' };
  const pick = (next: CoverDraft) => onChange(choiceBody(next, true));
  const thumb = (next: CoverDraft) => (
    <span className="cover-choice__thumb" aria-hidden="true">
      <ProfileCover
        cover={draftPreview(next, handle, 'pro')}
        sizes="(max-width: 520px) 45vw, 160px"
      />
    </span>
  );
  return (
    <>
      <fieldset className="cover-choices" role="radiogroup" disabled={disabled}>
        <legend>Cover</legend>
        <div className="cover-choices__grid">
          <label className="cover-choice">
            <input
              type="radio"
              name={`${id}-cover`}
              checked={value === null}
              onChange={() => onChange(null)}
            />
            <span className="cover-choice__name">Same as page</span>
          </label>
          {COVER_ANIMATIONS.map((option) => {
            const next: CoverDraft = {
              design: null,
              colour: draft.colour,
              animation: option.id,
              motion: draft.motion ?? 'once',
              animationColour: null,
            };
            return (
              <label key={option.id} className="cover-choice">
                <input
                  type="radio"
                  name={`${id}-cover`}
                  checked={value?.animation === option.id}
                  onChange={() => pick(next)}
                />
                {thumb(next)}
                <span className="cover-choice__name">{option.name}</span>
              </label>
            );
          })}
          {COVER_DESIGNS.map((design) => {
            const next: CoverDraft = {
              design: design.id,
              colour: draft.colour,
            };
            return (
              <label key={design.id} className="cover-choice">
                <input
                  type="radio"
                  name={`${id}-cover`}
                  checked={!value?.animation && value?.design === design.id}
                  onChange={() => pick(next)}
                />
                {thumb(next)}
                <span className="cover-choice__name">{design.name}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {draft.animation && (
        <fieldset
          className="cover-colours"
          role="radiogroup"
          disabled={disabled}
        >
          <legend>How it plays</legend>
          <div className="cover-colours__list">
            {(
              [
                ['once', 'Plays once'],
                ['loop', 'Slow loop'],
              ] as const
            ).map(([motion, label]) => (
              <label key={motion} className="cover-colour cover-motion">
                <input
                  type="radio"
                  name={`${id}-motion`}
                  checked={(draft.motion ?? 'once') === motion}
                  onChange={() => pick({ ...draft, motion })}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {!draft.animation && takesColours(draft.design) && (
        <fieldset
          className="cover-colours"
          role="radiogroup"
          disabled={disabled}
        >
          <legend>Colour</legend>
          <div className="cover-colours__list">
            {COVER_COLOURS.map((colour) => (
              <label key={colour.id} className="cover-colour">
                <input
                  type="radio"
                  name={`${id}-colour`}
                  checked={draft.colour === colour.id}
                  onChange={() => pick({ ...draft, colour: colour.id })}
                />
                <span
                  className="cover-colour__swatch"
                  style={{ background: colour.base }}
                  aria-hidden="true"
                />
                <span>{colour.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <p className="tm-hint">
        Optional. From the same covers as your page. “Same as page” uses yours.
      </p>
    </>
  );
}

/** The Free line under the locked editor, with the price the server sends (never written here). */
function useProLine(locked: boolean): string {
  const [price, setPrice] = useState<string | null>(null);
  useEffect(() => {
    if (!locked) return;
    let live = true;
    void readPrice().then((state) => {
      if (live && state.kind === 'price')
        setPrice(`${naira(state.price.amountMinor)} a month`);
    });
    return () => {
      live = false;
    };
  }, [locked]);
  return `Give each campaign its own page, goal and thank-you with TipMe Pro${price ? `, ${price}` : ''}.`;
}

type FieldErrors = Partial<Record<'headline' | 'description' | 'form', string>>;

/**
 * Campaign Studio's Page tab (ProCampaignPages board, section 2): whether the link opens a page
 * of its own, its headline, short description and cover, with a live preview. Free sees the same
 * editor locked over the preview. The name and link are edited as before, elsewhere.
 */
export function CampaignPageEditor({
  detail,
  onSaved,
}: {
  detail: CampaignDetail;
  onSaved: () => Promise<void> | void;
}) {
  const id = useId();
  const origin = useOrigin();
  const { profile } = useRecipient();
  const saved = detail.page ?? NO_PAGE;
  const locked = detail.pagesAvailable === false;
  const stopped = detail.stoppedAt !== null;
  const [on, setOn] = useState(saved.on);
  const [headline, setHeadline] = useState(saved.headline ?? '');
  const [description, setDescription] = useState(saved.description ?? '');
  const [cover, setCover] = useState<CoverDesignChoice | null>(saved.cover);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  // Phone: the preview opens full screen over the editor.
  const [previewing, setPreviewing] = useState(false);
  // Wide screens open the cover chooser; phones fold it into a row. The editor only mounts in
  // the browser, after the campaign has loaded, so reading the screen here is safe.
  const [coverOpen, setCoverOpen] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.('(min-width: 861px)').matches === true,
  );
  const proLine = useProLine(locked);
  const link = origin ? campaignLink(origin, detail.handle, detail.slug) : null;
  const disabled = locked || stopped || busy;

  const save = async () => {
    setStatus('');
    const parsed = campaignPageSchema.safeParse({
      on,
      headline,
      description,
      cover,
    });
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'headline' || field === 'description')
          next[field] ??= issue.message;
        else next.form ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await apiFetch<CampaignPageSettings>(
      `/v1/me/campaigns/${detail.id}/page`,
      { method: 'PUT', body: parsed.data },
    );
    setBusy(false);
    if (result.ok) {
      setHeadline(result.data.headline ?? '');
      setDescription(result.data.description ?? '');
      setCover(result.data.cover);
      setStatus('Saved');
      await onSaved();
      return;
    }
    if (result.code === 'CAMPAIGN_HEADLINE_NAME')
      setErrors({
        headline:
          'Use your own name in the headline, not someone else’s name or username.',
      });
    else if (result.code === 'CAMPAIGN_PRO_REQUIRED')
      setErrors({ form: 'A page for each campaign is part of TipMe Pro.' });
    else if (result.code === 'CAMPAIGN_STOPPED')
      setErrors({
        form: 'This campaign has stopped, so its page can’t change.',
      });
    else setErrors({ form: 'We couldn’t save the page. Please try again.' });
  };

  const preview = (
    <CampaignPagePreview
      displayName={profile.displayName}
      handle={profile.handle}
      avatarPath={profile.avatarPath ?? null}
      cover={coverOf(cover, profile.handle) ?? profile.cover ?? null}
      headline={on ? headline.trim() : ''}
      description={description.trim()}
      amountsMinor={profile.tipAmounts?.presetsMinor}
    />
  );

  return (
    <div className="campaign-page-editor">
      <form
        className="campaign-page-editor__form"
        aria-describedby={locked ? `${id}-locked` : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) void save();
        }}
      >
        {locked && (
          <p className="campaign-page-editor__locked" id={`${id}-locked`}>
            {proLine} <Link href="/pro">See Pro</Link>
          </p>
        )}
        {stopped && !locked && (
          <p className="tm-hint">
            This campaign has stopped. Its link opens your main page.
          </p>
        )}
        <div className="tip-remember campaign-page-editor__switch">
          <input
            id={`${id}-on`}
            type="checkbox"
            role="switch"
            checked={on}
            disabled={disabled}
            aria-describedby={`${id}-on-hint`}
            onChange={(event) => setOn(event.target.checked)}
          />
          <span>
            <label htmlFor={`${id}-on`}>Its own page</label>
            <span className="tm-hint" id={`${id}-on-hint`}>
              People who open this link or scan its QR see this page. Off: they
              see your normal page.
            </span>
          </span>
        </div>
        <InputField
          id={`${id}-headline`}
          label="Headline"
          hint={`${counterText(headline, CAMPAIGN_HEADLINE_MAX)}. The big line at the top of the page.`}
          value={headline}
          disabled={disabled}
          maxLength={CAMPAIGN_HEADLINE_MAX * 2}
          {...(errors.headline ? { error: errors.headline } : {})}
          onChange={(event) => setHeadline(event.target.value)}
        />
        <TextareaField
          id={`${id}-description`}
          label="Short description (optional)"
          hint={`${counterText(description, CAMPAIGN_DESCRIPTION_MAX)}. No links.`}
          value={description}
          disabled={disabled}
          maxLength={CAMPAIGN_DESCRIPTION_MAX * 2}
          {...(errors.description ? { error: errors.description } : {})}
          onChange={(event) => setDescription(event.target.value)}
        />
        <details
          className="campaign-page-editor__fold"
          open={coverOpen}
          onToggle={(event) => setCoverOpen(event.currentTarget.open)}
        >
          <summary>
            <span>Cover</span>
            <span className="campaign-page-editor__summary">
              {coverSummary(cover)}
            </span>
          </summary>
          <CoverPicker
            value={cover}
            onChange={setCover}
            handle={profile.handle}
            disabled={disabled}
          />
        </details>
        {errors.form && (
          <p className="tm-field-error" role="alert">
            {errors.form}
          </p>
        )}
        <p role="status" className="tm-hint">
          {status}
        </p>
        {!locked && !stopped && (
          <div className="campaign-page-editor__actions">
            <Button
              variant="secondary"
              className="campaign-page-editor__preview-button"
              onClick={() => setPreviewing(true)}
            >
              Preview
            </Button>
            <Button
              variant="continue"
              type="submit"
              disabled={busy}
              aria-busy={busy || undefined}
            >
              {busy ? 'Saving…' : 'Save page'}
            </Button>
            {link && (
              <a
                className="campaign-page-editor__open"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open the link
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </div>
        )}
      </form>
      <section
        className={`campaign-page-editor__preview${previewing ? ' is-open' : ''}`}
        aria-label="Live preview"
      >
        {previewing && (
          <div className="campaign-page-editor__back">
            <Button variant="quiet" onClick={() => setPreviewing(false)}>
              Back to editing
            </Button>
          </div>
        )}
        <p className="campaign-page-editor__preview-title">Live preview</p>
        {preview}
        <p className="tm-hint">Updates as you type.</p>
      </section>
    </div>
  );
}
