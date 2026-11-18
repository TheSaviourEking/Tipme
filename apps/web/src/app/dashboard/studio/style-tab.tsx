'use client';
import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import type {
  PhotoAccentFailed,
  PhotoAccentValues,
  StudioCheckResult,
  StudioCoverType,
  StudioDocument,
  StudioMode,
} from '@tipme/contracts';
import { AccentSwatches } from './accent-swatches';
import { ICONS, ProPill, Segmented } from './segmented';
import { StyleCards } from './style-cards';
import {
  MODE_LABEL,
  accentHeading,
  accentNote,
  coverChoices,
  proBanner,
  selectedAccent,
  styleHeading,
  withAccent,
  withCover,
  withMode,
  withStyle,
} from './style-tab-model';

/** The cover is chosen in Settings, the only place it is set (§10.5). */
export const COVER_SETTING = '/dashboard/settings#cover';

const MODES: readonly StudioMode[] = ['light', 'dark', 'auto'];

/**
 * The Style tab (styles spec §10; canvas "Choosing a style", phone Free, phone Pro, desktop Pro):
 * the live preview on a phone, then Style, Accent, Appearance, Cover and the way to the block
 * order, 28 px apart. Each choice is a real radio group. Switching style keeps what the new style
 * can use (style-tab-model). The editor's chrome keeps the dashboard's Manrope.
 */
export function StyleTab({
  draft,
  plan,
  name,
  hasAvatar,
  photoAccent,
  check,
  preview,
  onChange,
  onBlocks,
  readOnly,
  cardsId,
  coverChoice,
  onCoverChoice,
}: {
  draft: StudioDocument;
  plan: 'free' | 'pro';
  /** The person's display name, which every card is set in. */
  name: string;
  hasAvatar: boolean;
  photoAccent: PhotoAccentValues | PhotoAccentFailed | null;
  check: StudioCheckResult;
  /** On a phone, the live preview at the top of the tab (on a desktop it sits beside the panel). */
  preview?: ReactNode;
  onChange(next: StudioDocument): void;
  /** "Block order": opens the Blocks tab. */
  onBlocks(): void;
  readOnly: boolean;
  /** The style cards' heading id, which the check's "Choose a free style" moves focus to. */
  cardsId: string;
  /** The person's last explicit cover choice, kept by the editor outside the document. */
  coverChoice: StudioCoverType;
  onCoverChoice(cover: StudioCoverType): void;
}) {
  const id = useId();
  const note = accentNote(draft, { plan, hasAvatar, photoAccent });
  // The design check's notice for Stage and Horizon on a cover that isn't a photo (§5.5).
  const coverNotice = check.notices.find((n) => n.rule === 'cover-photo');
  return (
    <div className="pst-style">
      {preview}
      <section className="pst-section" aria-labelledby={cardsId}>
        <div className="pst-section__head">
          <h2 id={cardsId}>Style</h2>
          <span>{styleHeading(plan)}</span>
        </div>
        <StyleCards
          doc={draft}
          plan={plan}
          name={name}
          photoAccent={photoAccent}
          labelledBy={cardsId}
          bannerId={`${id}-pro`}
          readOnly={readOnly}
          onChange={(style) => onChange(withStyle(draft, style, coverChoice))}
        />
        {plan !== 'pro' && (
          <Link className="pst-banner" href="/pro" id={`${id}-pro`}>
            <ProPill large />
            <span className="sr-only"> · </span>
            <span className="pst-banner__words">{proBanner()}</span>
            {ICONS.chevron}
          </Link>
        )}
      </section>

      <section className="pst-section" aria-labelledby={`${id}-accent`}>
        <div className="pst-section__head">
          <h2 id={`${id}-accent`}>Accent</h2>
          <span>{accentHeading(draft)}</span>
        </div>
        <AccentSwatches
          styleId={draft.style}
          value={selectedAccent(draft)}
          plan={plan}
          hasAvatar={hasAvatar}
          labelledBy={`${id}-accent`}
          noteId={`${id}-accent-note`}
          readOnly={readOnly}
          onChange={(accent) => onChange(withAccent(draft, accent))}
        />
        {note && (
          <p id={`${id}-accent-note`} className="pst-note">
            {note}
          </p>
        )}
      </section>

      <section className="pst-section" aria-labelledby={`${id}-mode`}>
        <div className="pst-section__head">
          <h2 id={`${id}-mode`}>Appearance</h2>
        </div>
        <Segmented
          labelledBy={`${id}-mode`}
          options={MODES.map((m) => ({
            value: m,
            label: MODE_LABEL[m],
            icon: ICONS[m],
          }))}
          value={draft.mode}
          readOnly={readOnly}
          onChange={(mode) => onChange(withMode(draft, mode))}
        />
        <p className="pst-note">Auto follows each visitor’s phone setting.</p>
      </section>

      <section className="pst-section" aria-labelledby={`${id}-cover`}>
        <div className="pst-section__head">
          <h2 id={`${id}-cover`}>Cover</h2>
        </div>
        <Segmented
          labelledBy={`${id}-cover`}
          options={coverChoices(draft.style).map((c) => ({
            ...c,
            icon: ICONS[c.value],
          }))}
          value={draft.cover}
          readOnly={readOnly}
          onChange={(cover) => {
            onCoverChoice(cover);
            onChange(withCover(draft, cover));
          }}
        />
        <p className="pst-note">
          <Link href={COVER_SETTING}>Change your cover in Settings.</Link>
        </p>
        {coverNotice && (
          <p className="pst-note pst-note--notice">{coverNotice.message}</p>
        )}
      </section>

      <button type="button" className="pst-order" onClick={onBlocks}>
        {ICONS.grip}
        <span className="pst-order__words">
          <b>Block order</b>
          <span>Drag blocks in the Blocks tab</span>
        </span>
        {ICONS.chevron}
      </button>
    </div>
  );
}
