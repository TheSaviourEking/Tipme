/**
 * README: how a style's CSS reaches the page (spec 2026-11-17-page-studio-styles §4.3, §16).
 *
 * Next.js links every stylesheet imported from the /@username route's module graph on every
 * profile page (apps/web/test/route-css.test.mjs), standard ones included, and a prefetch of any
 * /@username link preloads it. So no style CSS is imported from here. Each style has a sheet
 * module (sheets/<style>.tsx) that imports frame.css (the shared skeleton, the form skin's common
 * rules, the sticky Tip bar, reduced motion) and the style's own file (clear.css: §9.2 exactly),
 * and renders nothing. style-sheets.tsx loads the page's one sheet through next/dynamic, so it is
 * linked, render-blocking, only in the HTML of a page that renders that style. A standard or
 * Classic page links none of it (budget 8 KB gzip of Studio CSS); a styled page links its route's
 * sheets plus frame and its style (budget 12 KB gzip). Every selector starts
 * `.studio[data-style…]`. The budgets are tested on the production build.
 *
 * Tokens: the root carries the resolved token map (`PublicStudio.palette`) as `--studio-*` custom
 * properties for its mode; auto adds the dark map inside `prefers-color-scheme: dark`, so it needs
 * no script and never flashes. Fonts: `@font-face` for Studio Inter and the style's display face
 * only, and one preload, for the face that sets the name (style-fonts.ts).
 */
import type { ReactNode } from 'react';
import { preload } from 'react-dom';
import {
  isClassicDefault,
  splitLinksByPlace,
  type PublicProfile,
  type PublicStudio,
  type StudioStyleId,
} from '@tipme/contracts';
import { StandardProfile } from '@/components/profile/standard-profile';
import { ClassicStudio } from './classic';
import {
  PoweredBy,
  StyleBand,
  StyleBarName,
  StyleBlocks,
  StyleCover,
  StyleHero,
  StyleIconRow,
  StyleIdentity,
  StyleLinkRows,
  StyleLinks,
  StyleTop,
  coverKind,
  type CoverKind,
  type CoverSize,
} from './parts';
import { styleFontFaces, styleFontPreload } from './style-fonts';
import { StyleSheet } from './style-sheets';
import {
  autoDarkCss,
  chromeCss,
  modeTokens,
  styleTokens,
} from './style-tokens';

export type { TipSkin } from '@/components/appreciation-form';

/**
 * The site header over the cover (owner, 18 Nov 2026): where a page starts with a full-bleed
 * cover, the frame lays the header over it, transparent, its words white on a soft scrim, until
 * the hero has scrolled past (frame.css). Signboard's plain band is the cover: the header takes the
 * band's own label colour there. Every other page starts on bg, where today's header already runs
 * into the page. Stage draws its deep gradient for any cover but a photo (dark at the top); Horizon's
 * other covers are the name on card, and Clear's gradient a pale tint beside bg.
 */
const HEADER_OVER: Partial<Record<StudioStyleId, readonly CoverKind[]>> = {
  stage: ['photo', 'art', 'gradient'],
  horizon: ['photo'],
  sprint: ['photo', 'art'],
  signboard: ['photo', 'art'],
  clear: ['photo', 'art'],
  // Creator's gradient is pale in light mode, where white header words would fail (addendum §6.7).
  creator: ['photo'],
  // Professional's gradient is a pale tint in light mode too, and its art is a band (addendum §6.7).
  professional: ['photo'],
};

/**
 * The styles that set the identity over a full-bleed cover photo (§9.4, §9.9). Not `needsPhoto`:
 * Creator needs a photo too, but never sets text on it (Creator plan ruling P4, addendum §7.1).
 */
const OVER_PHOTO: readonly StudioStyleId[] = ['stage', 'horizon'];

export function studioHeader(
  style: StudioStyleId,
  kind: CoverKind,
): 'over' | 'band' | undefined {
  if (HEADER_OVER[style]?.includes(kind)) return 'over';
  return style === 'signboard' ? 'band' : undefined;
}

/**
 * A page in one of the eight new styles (§8 skeleton, §13): cover, identity, the Tip moment,
 * profile links, the blocks in the person's order, and today's footer. The tip block and the
 * footer are TipMe's own, passed in; the tip block carries its style through `skin`. Server
 * component; no client code but the stylesheet loader, the avatar, the Pro note and the video.
 */
export function StudioStylePage({
  studio,
  profile,
  tipBlock,
  footer,
  coverArt,
  coverSize,
}: {
  studio: PublicStudio;
  profile: PublicProfile;
  tipBlock: ReactNode;
  footer: ReactNode;
  coverArt: ReactNode;
  /** The cover photo's own size, when known, so no rendition wider than it is offered. */
  coverSize?: CoverSize;
}) {
  const { document: doc, images, palette } = studio;
  const style = doc.style;
  const firstName = profile.displayName.split(/\s+/)[0] ?? profile.displayName;
  preload(styleFontPreload(style, profile.displayName), {
    as: 'font',
    type: 'font/woff2',
    crossOrigin: 'anonymous',
  });
  const own = modeTokens(
    style,
    palette,
    doc.mode === 'dark' ? 'dark' : 'light',
  );
  const css =
    styleFontFaces(style) +
    (doc.mode === 'auto'
      ? autoDarkCss(modeTokens(style, palette, 'dark'))
      : '') +
    // The site's header and footer take the page's neutrals (owner, ruling P).
    chromeCss(style, palette, doc.mode);
  // Stage and Horizon set the identity over a full-bleed cover photo (§9.4, §9.9).
  const overPhoto = OVER_PHOTO.includes(style);
  const creator = style === 'creator';
  const professional = style === 'professional';
  // The styles that split links into an icon row and rows (addendum §5.4).
  const placedLinks = creator || professional;
  const tip = (
    <section
      className="studio-tip"
      aria-label={`Tip ${firstName}`}
      // Horizon's "Send a tip" lands here and moves focus to the Tip area.
      {...(style === 'horizon' ? { id: 'studio-tip', tabIndex: -1 } : {})}
    >
      {/* Linen's Tip moment is a titled card (§9.8). */}
      {style === 'linen' && <h2 className="studio-tip__title">Send a tip</h2>}
      {/* Tiles' is the Tip tile, with the canvas's two lines (§9.7). */}
      {style === 'tiles' && (
        <div className="studio-tip__head">
          <h2 className="studio-tip__title">Send a tip</h2>
          <p className="studio-tip__to">Goes to {firstName}</p>
        </div>
      )}
      {tipBlock}
    </section>
  );
  const cover = (
    <StyleCover
      doc={doc}
      cover={profile.cover}
      coverArt={coverArt}
      // Creator's and Professional's tall crops are offered no rendition wider than the photo (as
      // Stage's hero); the other styles' covers are drawn as before.
      {...(placedLinks && coverSize ? { coverSize } : {})}
    />
  );
  const identity = (
    <StyleIdentity styleId={style} profile={profile} firstName={firstName} />
  );
  const links = <StyleLinks links={profile.links ?? []} />;
  // Creator and Professional (addendum §5.4): follow sites as icons under the identity, the rest as
  // rows (after the Tip on Creator, above it in Professional's card), the featured link the first.
  const placed = splitLinksByPlace(profile.links ?? []);
  const header = studioHeader(style, coverKind(doc, profile.cover));
  return (
    <div
      className="studio"
      data-style={style}
      data-mode={doc.mode}
      {...(header ? { 'data-header': header } : {})}
      style={styleTokens(own)}
    >
      <style>{css}</style>
      <StyleSheet styleId={style} />
      <div className="studio-page">
        {style === 'journal' && <StyleTop profile={profile} />}
        {overPhoto ? (
          <>
            <StyleHero
              doc={doc}
              profile={profile}
              {...(coverSize ? { coverSize } : {})}
            />
            {/* Below the cover: the bio with the Tip (Stage's desktop card holds both, and the
                handle; Horizon's desktop column titles them "Send a tip"). */}
            <div className="studio-lead">
              {style === 'horizon' && (
                <h2 className="studio-lead__title">Send a tip</h2>
              )}
              {profile.bio && <p className="studio-bio">{profile.bio}</p>}
              {profile.celebration && (
                <p className="studio-celebration">
                  Celebrating {firstName}’s {profile.celebration.label}
                </p>
              )}
              {tip}
              {style === 'stage' && (
                <p className="studio-lead__handle">@{profile.handle}</p>
              )}
            </div>
          </>
        ) : style === 'signboard' ? (
          // Signboard (§9.5): the band (the cover, or the short band under a photo cover), then a
          // desktop's left column (identity, Tip, the first section) beside the links and the rest.
          <>
            {cover}
            <StyleBand styleId={style} profile={profile} />
            <div className="studio-side">
              {identity}
              {tip}
              <StyleBlocks doc={doc} images={images} part="lead" />
            </div>
          </>
        ) : style === 'tiles' ? (
          // Tiles (§9.7): the cover (none when plain) and the Tip are tiles of the grid below.
          identity
        ) : creator ? (
          // Creator (addendum §7.1): the cover, then a desktop's 420 px column of identity, icon row
          // and Tip beside the rows and blocks.
          <>
            {cover}
            <div className="studio-side">
              {identity}
              <StyleIconRow links={placed.icons} />
              {tip}
            </div>
          </>
        ) : professional ? (
          // Professional (addendum §7.2): the card rising over the cover holds the identity and icon
          // row (a desktop's left column), the rows, the chips and the pill, and "Powered by tipme"
          // at its foot (the right column, 400). The blocks follow the card.
          <>
            {cover}
            <div className="studio-card">
              <div className="studio-card__side">
                {identity}
                <StyleIconRow links={placed.icons} />
              </div>
              <div className="studio-card__main">
                <StyleLinkRows links={placed.rows} />
                {tip}
                <PoweredBy />
              </div>
            </div>
          </>
        ) : (
          <>
            {cover}
            {identity}
            {tip}
          </>
        )}
        {professional ? (
          // With no blocks the page ends at the card, then the footer (§7.2).
          doc.blocks.length > 0 && (
            <div className="studio-grid">
              <StyleBlocks doc={doc} images={images} />
            </div>
          )
        ) : style === 'tiles' ? (
          <div className="studio-grid">
            {cover}
            {tip}
            {links}
            {/* With neither a cover tile nor links, the first block sits beside the Tip tile. */}
            <StyleBlocks
              doc={doc}
              images={images}
              beside={
                doc.cover === 'plain' && (profile.links?.length ?? 0) === 0
              }
            />
          </div>
        ) : (
          <div className="studio-grid">
            {creator ? <StyleLinkRows links={placed.rows} /> : links}
            <StyleBlocks
              doc={doc}
              images={images}
              lead={style === 'signboard'}
            />
          </div>
        )}
        <div className="studio-foot">
          {/* "Powered by tipme" at the foot of Creator's page, above the footer (§6.6). */}
          {creator && <PoweredBy />}
          {footer}
        </div>
      </div>
      {(style === 'journal' || style === 'stage') && (
        <StyleBarName styleId={style} profile={profile} />
      )}
    </div>
  );
}

/**
 * The one entry for a published style (§13): Classic renders today's markup with its choices
 * (ClassicStudio, §9.1); every other style renders the new frame. `identity` is TipMe's identity
 * block, which only Classic uses (the new styles draw their own).
 */
export function renderStyled(
  props: Parameters<typeof StudioStylePage>[0] & {
    identity: ReactNode;
    lead?: ReactNode;
  },
) {
  const { identity, lead, ...rest } = props;
  const doc = props.studio.document;
  // Classic with every default is today's page, byte for byte (§4.3, §9.1): the standard markup
  // through the same component as a page with no Studio, with no Classic root, tokens or sheet.
  if (isClassicDefault(doc))
    return (
      <StandardProfile
        firstName={
          props.profile.displayName.split(/\s+/)[0] ?? props.profile.displayName
        }
        lead={lead}
        cover={props.coverArt}
        identity={identity}
        tipBlock={props.tipBlock}
        footer={props.footer}
      />
    );
  return doc.style === 'classic' ? (
    <ClassicStudio {...rest} identity={identity} {...(lead ? { lead } : {})} />
  ) : (
    <StudioStylePage {...rest} />
  );
}
