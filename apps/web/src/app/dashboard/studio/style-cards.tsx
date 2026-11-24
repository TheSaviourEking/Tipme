'use client';
import type { CSSProperties } from 'react';
import {
  STUDIO_STYLES,
  STUDIO_STYLE_IDS,
  accentValues,
  type PhotoAccentFailed,
  type PhotoAccentValues,
  type StudioDocument,
  type StudioStyleId,
} from '@tipme/contracts';
import { needsInter } from '@/components/studio-styles/style-fonts';
import { ICONS, ProPill, RadioGroup } from './segmented';
import { styleCardLabel } from './style-tab-model';

/**
 * The style cards (§10.2; canvas "Choosing a style"): one per style in registry order, each a
 * schematic miniature (r14) of the style, set in the person's own name and the style's display
 * face, drawn in the current accent (each style's own while none is picked). Classic carries
 * DEFAULT; Pro styles carry PRO for Free. Every card can be chosen, on any plan (§12.4, overriding
 * the canvas's aria-disabled Pro cards): on Free a Pro style is a preview the editor doesn't save.
 * The selected card has a 2 px page + 4 px purple ring, a 22 px check badge and a 750 label.
 */
export function StyleCards({
  doc,
  plan,
  name,
  photoAccent,
  labelledBy,
  onChange,
  readOnly,
}: {
  doc: StudioDocument;
  plan: 'free' | 'pro';
  name: string;
  photoAccent: PhotoAccentValues | PhotoAccentFailed | null;
  labelledBy: string;
  onChange(style: StudioStyleId): void;
  readOnly: boolean;
}) {
  return (
    <RadioGroup
      labelledBy={labelledBy}
      items={STUDIO_STYLE_IDS.map((id) => ({
        value: id,
        key: id,
        label: styleCardLabel(id),
      }))}
      value={doc.style}
      onChange={onChange}
      readOnly={readOnly}
      className="pst-cards"
      itemClassName="pst-card"
      render={(item, checked) => {
        const id = item.value;
        const style = STUDIO_STYLES[id];
        const natural = style.naturalMode;
        const acc = accentValues(id, doc.accent, natural, photoAccent);
        return (
          <>
            <span className="pst-card__art">
              <Miniature
                styleId={id}
                name={name}
                vars={{
                  '--m-acc': acc.fill,
                  '--m-acc-label': acc.label,
                  '--m-acc-text': acc.text,
                }}
              />
              {id === 'classic' ? (
                <span className="pst-card__badge">
                  <span className="pst-pro pst-pro--default">DEFAULT</span>
                </span>
              ) : style.plan === 'pro' && plan !== 'pro' ? (
                <span className="pst-card__badge">
                  <ProPill />
                </span>
              ) : null}
              {checked && (
                <span className="pst-card__check">{ICONS.check(14)}</span>
              )}
            </span>
            <span className="pst-card__name">
              {style.name}
              {id === 'classic' && (
                <span className="pst-card__plan"> · Free</span>
              )}
            </span>
          </>
        );
      }}
    />
  );
}

type Vars = CSSProperties & Record<`--${string}`, string>;

/** The canvas's schematic of each style, 120 × 200 drawn at 104 wide. Decorative. */
function Miniature({
  styleId,
  name,
  vars,
}: {
  styleId: StudioStyleId;
  name: string;
  vars: Vars;
}) {
  const shown = (
    <span
      className="pst-mini__name"
      data-inter={needsInter(styleId, name) || undefined}
    >
      {name}
    </span>
  );
  const bars = (...widths: number[]) =>
    widths.map((w, i) => (
      <span key={i} className="pst-mini__bar" style={{ width: w }} />
    ));
  const chips = (n = 4) => (
    <span className="pst-mini__chips">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} data-on={i === 1 || undefined} />
      ))}
    </span>
  );
  const avatar = <span className="pst-mini__avatar" />;
  return (
    <span className="pst-mini" data-mini={styleId} style={vars} aria-hidden>
      {styleId === 'classic' ? (
        <>
          <span className="pst-mini__top">
            <span />
            <span />
          </span>
          <span className="pst-mini__cover" />
          <span className="pst-mini__id">
            {avatar}
            {shown}
            {bars(64)}
            <span className="pst-mini__links">
              <span />
              <span />
              <span />
            </span>
          </span>
          <span className="pst-mini__card">
            <span className="pst-mini__title" />
            {chips(3)}
            <span className="pst-mini__field" />
            <span className="pst-mini__button" />
          </span>
        </>
      ) : styleId === 'clear' ? (
        <>
          <span className="pst-mini__cover" />
          <span className="pst-mini__id">
            {avatar}
            {shown}
            {bars(70, 56)}
          </span>
          <span className="pst-mini__track">
            <span />
          </span>
          <span className="pst-mini__button" />
          <span className="pst-mini__card" />
        </>
      ) : styleId === 'journal' ? (
        <span className="pst-mini__pad">
          <span className="pst-mini__mast">
            {bars(40)}
            {avatar}
          </span>
          {shown}
          {bars(96, 80)}
          {chips()}
          <span className="pst-mini__button" />
          <span className="pst-mini__quote">
            “Every song started as a voice note…”
          </span>
          <span className="pst-mini__rule" />
          <span className="pst-mini__rule" />
        </span>
      ) : styleId === 'stage' ? (
        <>
          <span className="pst-mini__cover">{shown}</span>
          <span className="pst-mini__pad">
            {chips()}
            <span className="pst-mini__button" />
            <span className="pst-mini__card" />
            <span className="pst-mini__card" />
          </span>
        </>
      ) : styleId === 'signboard' ? (
        <>
          <span className="pst-mini__band">{shown}</span>
          <span className="pst-mini__pad">
            {avatar}
            {bars(90, 70)}
            {chips()}
            <span className="pst-mini__button" />
            <span className="pst-mini__card" />
            <span className="pst-mini__card" />
          </span>
        </>
      ) : styleId === 'sprint' ? (
        <>
          <span className="pst-mini__cover" />
          <span className="pst-mini__pad">
            {shown}
            {chips()}
            <span className="pst-mini__button" />
            <span className="pst-mini__row">{bars(60)}</span>
            <span className="pst-mini__row">{bars(60)}</span>
            <span className="pst-mini__row">{bars(60)}</span>
          </span>
        </>
      ) : styleId === 'tiles' ? (
        <span className="pst-mini__pad">
          <span className="pst-mini__head">
            {avatar}
            {shown}
          </span>
          <span className="pst-mini__grid">
            <span className="pst-mini__tip">
              {chips()}
              <span className="pst-mini__button" />
            </span>
            <span className="pst-mini__tile">
              <span />
            </span>
            <span className="pst-mini__tile">
              <span />
            </span>
            <span className="pst-mini__photo" />
          </span>
        </span>
      ) : styleId === 'linen' ? (
        <>
          <span className="pst-mini__frame">
            <span className="pst-mini__cover" />
          </span>
          <span className="pst-mini__pad">
            {shown}
            {bars(90)}
            <span className="pst-mini__card">
              {chips()}
              <span className="pst-mini__button" />
            </span>
            <span className="pst-mini__pair">
              <span />
              <span />
            </span>
          </span>
        </>
      ) : (
        <>
          <span className="pst-mini__cover">
            <span className="pst-mini__over">
              {shown}
              <span className="pst-mini__button" />
              <span className="pst-mini__glass" />
            </span>
          </span>
          <span className="pst-mini__pad">
            {chips()}
            <span className="pst-mini__card" />
          </span>
        </>
      )}
    </span>
  );
}
