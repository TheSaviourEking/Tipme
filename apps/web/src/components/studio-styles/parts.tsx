import type { ReactNode } from 'react';
import {
  RENDITION_WIDTHS,
  SOCIAL_PLATFORMS,
  STUDIO_IMAGE_ASPECT,
  COVER_SIZE,
  coverRenditionPath,
  embedUrl,
  linkHandle,
  parseVideoLink,
  studioSlotWidth,
  type PublicProfile,
  type PublicStudio,
  type SocialLink,
  type StudioBlock,
  type StudioDocument,
  type StudioStyleId,
} from '@tipme/contracts';
import { ProBadge } from '@tipme/ui';
import { AvatarImage } from '@/components/avatar';
import { LinkBadge } from '@/components/profile/link-badge';
import { Money } from '@/components/money';
import { API_ORIGIN } from '@/lib/avatar-source';
import { needsInter } from './style-fonts';
import { VideoEmbed } from './video-embed';

/**
 * The parts every style draws (spec 2026-11-17-page-studio-styles §8): cover, identity, profile
 * links and blocks. One markup for all styles; each style's CSS (keyed by `data-style`) gives it
 * its look. Every piece of user text is React text, never HTML, and a block with nothing to show
 * renders nothing. Server components; the avatar, the Pro badge's note and the video are islands.
 */

const external = {
  rel: 'noopener noreferrer nofollow ugc',
  target: '_blank',
} as const;
const NEW_TAB = ' (opens in a new tab)';

type Images = PublicStudio['images'];
type Shape = keyof typeof STUDIO_IMAGE_ASPECT;

/** An uploaded cover (the API's) or the lab's generated one; anything else is not a photo here. */
const API_COVER = /^\/v1\/covers\/[0-9a-f-]+\/\d+\.webp$/;
const LAB_COVER = /^\/dev\/studio-lab\/image\/[0-9a-f-]{36}$/;
/** The lab's stand-in for an uploaded cover: one file, like the API's. */
const LAB_UPLOAD = /^\/dev\/studio-lab\/cover\/\d+\.webp$/;

/** A cover photo's own pixel size, where it is known (the lab's generated covers). */
export type CoverSize = { width: number; height: number };

/** The site header's height (globals.css `--nav-height`): a full-bleed cover runs up under it. */
const NAV_HEIGHT = 76;

/**
 * The styles that set the identity over a full-bleed cover photo (§9.4, §9.9), and how tall that
 * photo is drawn on a phone and from 1024 px: stage.css, horizon.css `--tall` plus the header strip
 * it runs up under (frame.css; a unit test holds them equal). They need a photo (`needsPhoto`): any
 * other cover draws their gradient treatment.
 */
export const STYLE_COVER: Partial<
  Record<StudioStyleId, { tall: number; desktopTall: number }>
> = {
  stage: { tall: 488 + NAV_HEIGHT, desktopTall: 640 + NAV_HEIGHT },
  horizon: { tall: 640 + NAV_HEIGHT, desktopTall: 836 + NAV_HEIGHT },
};

/**
 * `sizes` for a cover photo: full-bleed, and where the box is taller than the photo's shape
 * (object-fit: cover fills the height) it is drawn wider than the screen, so the slot is the wider
 * of the two. Stage and Horizon crop tall; Clear, Sprint (phone) and Signboard are as tall as their
 * CSS height plus the header strip (clear.css, sprint.css, signboard.css; a unit test reads them).
 */
function coverSizes(
  style: StudioStyleId,
  aspect: number = STUDIO_IMAGE_ASPECT.wide,
): string {
  const w = (h: number) => Math.ceil(h * aspect);
  const tall = STYLE_COVER[style];
  if (tall) {
    const phone = w(tall.tall);
    const desk = w(tall.desktopTall);
    return `(min-width: ${desk}px) 100vw, (min-width: 1024px) ${desk}px, (min-width: ${phone}px) 100vw, ${phone}px`;
  }
  if (style === 'clear')
    return `(min-width: 1024px) max(100vw, ${w(380 + NAV_HEIGHT)}px), max(100vw, ${w(220 + NAV_HEIGHT)}px)`;
  // A desktop's photo is the left half, beside the name (as before).
  if (style === 'sprint')
    return `(min-width: 1024px) 100vw, max(100vw, ${w(440 + NAV_HEIGHT)}px)`;
  // 16:9 of the screen up to 560 tall, then the strip.
  if (style === 'signboard')
    return `max(100vw, calc(min(${Number((56.25 * aspect).toFixed(2))}vw, ${w(560)}px) + ${w(NAV_HEIGHT)}px))`;
  return '100vw';
}

function coverPhoto(
  cover: PublicProfile['cover'],
  style: StudioStyleId,
  size?: CoverSize,
): { src: string; srcSet?: string; sizes?: string } | null {
  if (cover?.kind !== 'photo') return null;
  // An uploaded cover (the API's, or the lab's stand-in): one 2240 × 600 file, and its renditions
  // when the API lists them; without them, the one file, as before.
  const api = API_COVER.test(cover.path);
  if (api || LAB_UPLOAD.test(cover.path)) {
    const at = (path: string) => (api ? `${API_ORIGIN}${path}` : path);
    const widths = cover.widths ?? [];
    if (widths.length === 0) return { src: at(cover.path) };
    const narrow = widths.filter((w) => w <= 1080).at(-1) ?? widths[0]!;
    return {
      src: at(coverRenditionPath(cover.path, narrow)),
      srcSet: [
        ...widths.map((w) => `${at(coverRenditionPath(cover.path, w))} ${w}w`),
        `${at(cover.path)} ${COVER_SIZE.width}w`,
      ].join(', '),
      // Drawn at the band's own shape: a tall crop shows it far wider than the screen.
      sizes: coverSizes(style, COVER_SIZE.width / COVER_SIZE.height),
    };
  }
  if (!LAB_COVER.test(cover.path)) return null;
  // Renditions of the photo's 16:9 crop, never wider than the photo allows (no upscaling); the
  // smallest is always offered.
  const usable = size
    ? Math.min(size.width, size.height * STUDIO_IMAGE_ASPECT.wide)
    : Infinity;
  const widths = RENDITION_WIDTHS.filter((w, i) => i === 0 || w <= usable);
  const src = widths.filter((w) => w <= 960).at(-1) ?? widths[0] ?? 480;
  return {
    src: `${cover.path}/wide-${src}`,
    srcSet: widths.map((w) => `${cover.path}/wide-${w} ${w}w`).join(', '),
    sizes: coverSizes(style),
  };
}

/** The cover photo: the likely LCP, so eager and high priority; cropped by the style's CSS. */
function CoverPhoto({
  photo,
}: {
  photo: NonNullable<ReturnType<typeof coverPhoto>>;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the cover's own file, already sized
    <img
      className="studio-cover__photo"
      src={photo.src}
      {...(photo.srcSet ? { srcSet: photo.srcSet, sizes: photo.sizes } : {})}
      alt=""
      loading="eager"
      fetchPriority="high"
      decoding="async"
    />
  );
}

/**
 * The cover slot. "Your cover" is the one set in Settings: a photo in the style's photo treatment,
 * anything else as today's cover art. Gradient and plain are drawn by the style's CSS from its
 * tokens.
 */
export function StyleCover({
  doc,
  cover,
  coverArt,
  coverSize,
}: {
  doc: StudioDocument;
  cover: PublicProfile['cover'];
  coverArt: ReactNode;
  coverSize?: CoverSize;
}) {
  if (doc.cover !== 'yours')
    return (
      <div className="studio-cover" data-cover={doc.cover} aria-hidden="true" />
    );
  const photo = coverPhoto(cover, doc.style, coverSize);
  if (!photo)
    return (
      <div className="studio-cover" data-cover="art">
        {coverArt}
      </div>
    );
  return (
    <div className="studio-cover" data-cover="photo">
      <CoverPhoto photo={photo} />
      <div className="studio-cover__fade" />
    </div>
  );
}

/** What the cover slot draws: the person's photo, today's cover art, or the style's own. */
export type CoverKind = 'photo' | 'art' | 'gradient' | 'plain';

export function coverKind(
  doc: StudioDocument,
  cover: PublicProfile['cover'],
): CoverKind {
  if (doc.cover !== 'yours') return doc.cover;
  return coverPhoto(cover, doc.style) ? 'photo' : 'art';
}

/** The treatment a needsPhoto style draws: its photo, or its gradient for any other cover (§13). */
function heroCover(
  doc: StudioDocument,
  cover: PublicProfile['cover'],
  coverSize?: CoverSize,
) {
  if (doc.cover === 'plain') return { kind: 'plain' as const, photo: null };
  const photo =
    doc.cover === 'yours' ? coverPhoto(cover, doc.style, coverSize) : null;
  return photo
    ? { kind: 'photo' as const, photo }
    : { kind: 'gradient' as const, photo: null };
}

/**
 * Whether a name would take a third line at the style's phone size, so it steps down about 80%
 * (§9.10, builder's call): more than 26 letters, or a word (hyphens break) of more than 13.
 * Signboard's wide face steps down sooner, over 18 letters (§9.10, canvas "Long names"), and so
 * does Tiles' name, which shares its line with the avatar; Sprint's capitals at a word of 10.
 * Marks are not letters: "ọ́" counts once.
 */
export function longName(name: string, style?: StudioStyleId): boolean {
  const letters = name.normalize('NFD').replace(/\p{M}/gu, '');
  const count = letters.replace(/[\s-]/g, '').length;
  if (style === 'signboard' || style === 'tiles') return count > 18;
  const words = letters.split(/[\s-]+/);
  // Sprint's Anton capitals are about 0.52 em each: at 64 px a 10-letter word fills the phone.
  const word = style === 'sprint' ? 9 : 13;
  return (
    letters.replace(/\s/g, '').length > 26 || words.some((w) => w.length > word)
  );
}

/**
 * A name with marks above or below its letters (ọ́, ẹ, ṣ…). Sprint's capitals at 64/76 or 52/1.2
 * let a dot below touch the next line's acute (ruling AB; e2e measures the ink), so such a name
 * opens its line height. A name with none keeps the spec's 64/76.
 */
const MARKED = /\p{M}/u;

/** The page's one h1: the name, wholly in Inter where the display face can't draw it (§4.1). */
function StyleName({
  styleId: style,
  name,
}: {
  styleId: StudioStyleId;
  name: string;
}) {
  return (
    <h1
      id="studio-name"
      className={`studio-name${needsInter(style, name) ? ' studio-name--fallback' : ''}${longName(name, style) ? ' studio-name--long' : ''}${style === 'sprint' && MARKED.test(name.normalize('NFD')) ? ' studio-name--marks' : ''}`}
    >
      {name}
    </h1>
  );
}

/**
 * Signboard's band (§9.5): the role as its small caps label and the name, in the accent. On a
 * plain cover it is the cover; under a photo it is the short band below it, never over it.
 */
export function StyleBand({
  styleId,
  profile,
}: {
  styleId: StudioStyleId;
  profile: PublicProfile;
}) {
  return (
    <div className="studio-band">
      {profile.role && (
        <p
          className={`studio-kicker${needsInter(styleId, profile.role) ? ' studio-kicker--fallback' : ''}`}
        >
          {profile.role}
        </p>
      )}
      <StyleName styleId={styleId} name={profile.displayName} />
    </div>
  );
}

/**
 * Name, photo, meta (@username · role), Pro badge, bio and any shared moment. Signboard's name and
 * role sit in its band (StyleBand), so its identity holds the rest.
 */
export function StyleIdentity({
  styleId: style,
  profile,
  firstName,
}: {
  styleId: StudioStyleId;
  profile: PublicProfile;
  firstName: string;
}) {
  const banded = style === 'signboard';
  // Journal shows this avatar on a desktop only (its phone avatar sits in the top row), so it is
  // not fetched eagerly there; it is never Journal's largest paint (the name is).
  const journal = style === 'journal';
  return (
    <header className="studio-identity" aria-labelledby="studio-name">
      <AvatarImage
        className="studio-avatar"
        src={profile.avatarPath ?? ''}
        name={profile.displayName}
        width={256}
        height={256}
        sizes={journal ? '72px' : '(max-width: 1023px) 104px, 128px'}
        priority={!journal}
      />
      {!banded && <StyleName styleId={style} name={profile.displayName} />}
      <p className="studio-meta">
        <span className="studio-meta__handle">@{profile.handle}</span>
        {!banded && profile.role && (
          <>
            <span className="studio-meta__sep"> · </span>
            <span className="studio-meta__role">{profile.role}</span>
          </>
        )}
        {profile.plan === 'pro' && <ProBadge explain className="studio-pro" />}
      </p>
      {profile.bio && <p className="studio-bio">{profile.bio}</p>}
      {profile.celebration && (
        <p className="studio-celebration">
          Celebrating {firstName}’s {profile.celebration.label}
        </p>
      )}
    </header>
  );
}

/**
 * Stage's and Horizon's identity (§9.4, §9.9): over a photo cover the label (Stage: the role), the
 * name and the meta sit at the photo's foot, white, on the style's scrim (`studio-scrim`), with no
 * avatar. A gradient or plain cover (and any cover that is not a photo) draws the style's own
 * treatment in the page's colours: Stage's plain one and both of Horizon's carry the avatar.
 * Horizon adds two buttons, plain links (no script): "Send a tip" to the Tip area, which takes
 * focus, and "See links" to the links, absent without links. The bio follows, in the lead.
 */
export function StyleHero({
  doc,
  profile,
  coverSize,
}: {
  doc: StudioDocument;
  profile: PublicProfile;
  coverSize?: CoverSize;
}) {
  const style = doc.style;
  const { kind, photo } = heroCover(doc, profile.cover, coverSize);
  const horizon = style === 'horizon';
  const avatar = horizon ? kind !== 'photo' : kind === 'plain';
  const size = horizon ? 96 : 112;
  return (
    <header
      className="studio-identity studio-hero"
      data-cover={kind}
      aria-labelledby="studio-name"
    >
      {photo ? (
        <div className="studio-cover" data-cover="photo">
          <CoverPhoto photo={photo} />
        </div>
      ) : (
        <div className="studio-cover" data-cover={kind} aria-hidden="true" />
      )}
      <div className={`studio-hero__words${photo ? ' studio-scrim' : ''}`}>
        {avatar && (
          <AvatarImage
            className="studio-avatar"
            src={profile.avatarPath ?? ''}
            name={profile.displayName}
            width={256}
            height={256}
            sizes={`${size}px`}
            priority
          />
        )}
        {!horizon && profile.role && (
          <p className="studio-kicker">{profile.role}</p>
        )}
        <h1
          id="studio-name"
          className={`studio-name${longName(profile.displayName) ? ' studio-name--long' : ''}`}
        >
          {profile.displayName}
        </h1>
        <p className="studio-meta">
          <span className="studio-meta__handle">@{profile.handle}</span>
          {horizon && profile.role && (
            <>
              <span className="studio-meta__sep"> · </span>
              <span className="studio-meta__role">{profile.role}</span>
            </>
          )}
          {profile.plan === 'pro' && (
            <ProBadge explain className="studio-pro" />
          )}
        </p>
        {horizon && (
          <div className="studio-hero__actions">
            {/* data-tip-cta: the phone's Tip bar stays down while this is in view (§8). */}
            <a className="studio-hero__tip" href="#studio-tip" data-tip-cta="">
              Send a tip
            </a>
            {(profile.links?.length ?? 0) > 0 && (
              <a className="studio-hero__links" href="#studio-links">
                See links
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M6.5 9.5L12 15l5.5-5.5" />
                </svg>
              </a>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

/**
 * Journal's top row (§9.3): the page opens on a category label (the person's role) with the
 * 40 px avatar on a phone, or the handle on a desktop, over a 1 px rule. Each breakpoint shows
 * one of the two avatars and one handle (CSS), so only one of each is ever in the tree.
 */
export function StyleTop({ profile }: { profile: PublicProfile }) {
  return (
    <div className="studio-top">
      {profile.role && <p className="studio-kicker">{profile.role}</p>}
      <p className="studio-top__handle">@{profile.handle}</p>
      <AvatarImage
        className="studio-avatar studio-avatar--top"
        src={profile.avatarPath ?? ''}
        name={profile.displayName}
        width={80}
        height={80}
        sizes="40px"
      />
    </div>
  );
}

/**
 * The name and handle on the phone's Tip bar (Journal §9.3, Stage §9.4 with the avatar; §9.10: one
 * line, ellipsis). It sits
 * beside the form's bar and shows only while the bar does (CSS); it repeats the page's heading,
 * so it stays out of the accessibility tree.
 */
export function StyleBarName({
  styleId,
  profile,
}: {
  styleId: StudioStyleId;
  profile: PublicProfile;
}) {
  return (
    <div className="studio-barname" aria-hidden="true">
      {/* Stage's bar leads with the 36 px avatar (§9.4). */}
      {styleId === 'stage' && (
        <AvatarImage
          className="studio-avatar studio-barname__avatar"
          src={profile.avatarPath ?? ''}
          name={profile.displayName}
          width={80}
          height={80}
          sizes="36px"
        />
      )}
      <p
        className={`studio-barname__name${needsInter(styleId, profile.displayName) ? ' studio-barname__name--fallback' : ''}`}
        data-truncate=""
      >
        {profile.displayName}
      </p>
      <p className="studio-barname__handle" data-truncate="">
        @{profile.handle}
      </p>
    </div>
  );
}

/** The person's saved links, once, under the fixed title (§8). Nothing at all without links. */
export function StyleLinks({ links }: { links: readonly SocialLink[] }) {
  if (!links.length) return null;
  return (
    <section
      className="studio-links"
      id="studio-links"
      aria-labelledby="studio-links-title"
    >
      <h2 id="studio-links-title" className="studio-title">
        Find me elsewhere
      </h2>
      <ul className="studio-links__list">
        {links.map((link) => {
          const { label } = SOCIAL_PLATFORMS[link.platform];
          const handle = linkHandle(link);
          return (
            <li key={link.url}>
              <a className="studio-link" href={link.url} {...external}>
                <LinkBadge platform={link.platform} small />
                <span className="studio-link__words">
                  {/* data-truncate: a style may end these with an ellipsis (the layout probe
                      accepts it only where marked). */}
                  <span className="studio-link__title" data-truncate="">
                    {label}
                  </span>
                  {handle && (
                    <span className="studio-link__sub" data-truncate="">
                      {handle}
                    </span>
                  )}
                </span>
                <svg
                  className="studio-link__chevron"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M9.5 6.5L15 12l-5.5 5.5" />
                </svg>
                <span className="sr-only">{NEW_TAB}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * `sizes` from the design check's own slot widths (studioSlotWidth), so the photo check and the
 * renditions a browser picks agree: the style's desktop slot, the tablet column, the phone column.
 */
function sizesFor(style: StudioStyleId, kind: StudioBlock['kind']): string {
  const at = (viewport: number) => studioSlotWidth(style, kind, viewport);
  // Sprint's photos run edge to edge at every width (§9.6): the slot is the screen.
  if (style === 'sprint' && (kind === 'photo' || kind === 'gallery'))
    return '100vw';
  // Classic is today's page (classic.css): two columns from 861 px, widest at 1200, then one
  // column of min(vw, 576) − 32, its photos 2-up with an 8 px gap.
  if (style === 'classic')
    return `(min-width: 1024px) ${at(1200)}px, (min-width: 861px) ${at(1023)}px, (min-width: 576px) ${at(576)}px, ${kind === 'gallery' ? 'calc(50vw - 20px)' : 'calc(100vw - 32px)'}`;
  return `(min-width: 1024px) ${at(1440)}px, (min-width: 768px) ${at(1023)}px, ${at(390)}px`;
}

/**
 * A gallery photo's `sizes` where a style draws photos of one gallery at different widths
 * (fix round 1): the photo that closes a row is wider than the rest.
 * - Tiles (tiles.css): a 2-column grid below 1024 (gap 12), an odd last photo spanning both; on a
 *   desktop 4 columns of 185 (gap 16), the last spanning what its row has left. The widest is the
 *   design check's slot.
 * - Sprint (sprint.css): edge to edge, 2-up below 1024 with an odd first photo taking the row; on
 *   a desktop 3-up, the first of 3n + 1 taking the row and the first two of 3n + 2 halving it.
 */
function gallerySizes(
  style: StudioStyleId,
  index: number,
  count: number,
): string {
  if (style === 'tiles') {
    const tile = (column: number, n: number, gap: number) =>
      Math.round((column - (n - 1) * gap) / n);
    const desk = studioSlotWidth('tiles', 'gallery', 1440);
    const deskTile = tile(desk, 4, 16);
    const left = count % 4;
    const span = index === count - 1 && left ? 5 - left : 1;
    const wide = index === count - 1 && count % 2 === 1;
    const at = (v: number) => {
      const column = studioSlotWidth('tiles', 'gallery', v);
      return wide ? column : tile(column, 2, 12);
    };
    return `(min-width: 1024px) ${span * deskTile + (span - 1) * 16}px, (min-width: 768px) ${at(1023)}px, ${at(390)}px`;
  }
  if (style === 'sprint') {
    const phone = index === 0 && count % 2 === 1 ? 100 : 50;
    const desk =
      count % 3 === 1 && index === 0
        ? 100
        : count % 3 === 2 && index < 2
          ? 50
          : 34;
    return `(min-width: 1024px) ${desk}vw, ${phone}vw`;
  }
  return sizesFor(style, 'gallery');
}

function Photo({
  images,
  imageId,
  alt,
  shape,
  sizes,
}: {
  images: Images;
  imageId: string;
  alt: string;
  shape: Shape;
  sizes: string;
}) {
  const image = images[imageId];
  if (!image) return null;
  // Renditions are 480, 960 and 1440 wide and never upscaled (Task 7).
  const aspect = STUDIO_IMAGE_ASPECT[shape];
  const usable = Math.min(image.width, image.height * aspect);
  const widths = RENDITION_WIDTHS.filter((w, i) => i === 0 || w <= usable);
  const url = (w: number) => `${image.path}/${shape}-${w}`;
  const largest = widths[widths.length - 1] ?? 480;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- TipMe's own renditions, already sized
    <img
      src={url(widths[0] ?? 480)}
      srcSet={widths.map((w) => `${url(w)} ${w}w`).join(', ')}
      sizes={sizes}
      width={largest}
      height={Math.round(largest / aspect)}
      alt={alt}
      loading="lazy"
      decoding="async"
    />
  );
}

function weekday(date: string) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  const part = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { ...o, timeZone: 'UTC' }).format(at);
  return {
    day: part({ weekday: 'short' }),
    date: part({ day: 'numeric' }),
    month: part({ month: 'short' }),
  };
}

/** "20:00" → "8 pm", "09:30" → "9:30 am". */
function clock(time: string) {
  const [h = 0, m = 0] = time.split(':').map(Number);
  const hour = h % 12 || 12;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
}

const SITE = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  audiomack: 'Audiomack',
} as const;

function Block({
  block: b,
  style,
  images,
}: {
  block: StudioBlock;
  style: StudioStyleId;
  images: Images;
}) {
  switch (b.kind) {
    case 'text':
      if (!b.text) return null;
      if (b.variant === 'heading')
        return (
          <h2
            className={`studio-title studio-block--heading${needsInter(style, b.text) ? ' studio-title--fallback' : ''}`}
          >
            {b.text}
          </h2>
        );
      return (
        <div className="studio-card studio-text">
          {b.text.split('\n\n').map((part, i) => (
            <p key={i}>{part}</p>
          ))}
        </div>
      );
    case 'quote':
      if (!b.text) return null;
      return (
        <figure className="studio-card studio-quote">
          <blockquote>
            <p>{b.text}</p>
          </blockquote>
        </figure>
      );
    case 'photo':
      if (!images[b.imageId]) return null;
      return (
        <figure className="studio-photo">
          <Photo
            images={images}
            imageId={b.imageId}
            alt={b.decorative ? '' : b.alt}
            shape="wide"
            sizes={sizesFor(style, 'photo')}
          />
          {b.caption && <figcaption>{b.caption}</figcaption>}
        </figure>
      );
    case 'gallery': {
      const shown = b.images.filter((i) => images[i.imageId]);
      if (!shown.length) return null;
      return (
        // A strip that scrolls sideways on a phone: focusable, so a keyboard can scroll it too.
        <ul
          className="studio-strip"
          data-strip
          tabIndex={0}
          aria-label="Photos"
        >
          {shown.map((image, i) => (
            <li key={`${image.imageId}-${i}`}>
              <Photo
                images={images}
                imageId={image.imageId}
                alt={image.decorative ? '' : image.alt}
                shape="tall"
                sizes={gallerySizes(style, i, shown.length)}
              />
            </li>
          ))}
        </ul>
      );
    }
    case 'video': {
      const video = parseVideoLink(b.url);
      if (!video) return null;
      return (
        <div className="studio-video">
          <VideoEmbed
            src={embedUrl(video)}
            site={SITE[video.site]}
            {...(b.caption ? { caption: b.caption } : {})}
          />
        </div>
      );
    }
    case 'services':
      if (!b.items.length) return null;
      return (
        <div className="studio-card studio-list">
          <ul>
            {b.items.map((item, i) => (
              <li key={i}>
                <span className="studio-list__words">
                  <span className="studio-list__title">{item.name}</span>
                  {item.detail && (
                    <span className="studio-list__sub">{item.detail}</span>
                  )}
                </span>
                <span className="studio-price">
                  {item.from ? 'from ' : ''}
                  <Money minor={item.priceMinor} />
                </span>
              </li>
            ))}
          </ul>
          <p className="studio-fine">
            Prices are for information. Tips here are a gift, not a payment for
            a service.
          </p>
        </div>
      );
    case 'events':
      if (!b.items.length) return null;
      return (
        <ul className="studio-card studio-list studio-events">
          {b.items.map((item, i) => {
            const when = weekday(item.date);
            const line = [item.time ? clock(item.time) : null, item.place]
              .filter(Boolean)
              .join(' · ');
            return (
              <li key={i}>
                <time className="studio-date" dateTime={item.date}>
                  <span>{when.month}</span>
                  <span className="studio-date__day">{when.date}</span>
                </time>
                <span className="studio-list__words">
                  <span className="studio-list__title">{item.title}</span>
                  {line && <span className="studio-list__sub">{line}</span>}
                  {item.note && (
                    <span className="studio-list__sub">{item.note}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      );
    case 'supporters':
      // Task 13 (its own switch); the schema refuses it until then.
      return null;
  }
}

/**
 * The blocks in the person's order, in sections: a heading starts a new one (§9: each section is
 * a title over its blocks, and on desktop a cell of the style's grid). Blocks before the first
 * heading form a section of their own. Each style's CSS places them (§9 layouts). A section of
 * lists only is `data-list` (a style may pair two); of photos only, `data-media` (Sprint's run
 * edge to edge on a desktop).
 *
 * Signboard's desktop puts the first section in its left column, under the Tip, and the rest
 * beside it (§9.5), while a phone keeps §8's order (the links first). One order can't be both, so
 * `lead` marks the first section here (a desktop hides it) and `part="lead"` draws that section
 * alone for the left column (shown on a desktop only). Each width shows one copy; the other is
 * `display: none`, out of the accessibility tree, and its lazy photos are never fetched.
 */
export function StyleBlocks({
  doc,
  images,
  lead = false,
  part = 'all',
  beside = false,
}: {
  doc: StudioDocument;
  images: Images;
  lead?: boolean;
  part?: 'all' | 'lead';
  /** Tiles with neither a cover tile nor links: something sits beside the Tip tile, so the grid's
   * first row is closed (fix rounds 1 and 2): the first photo (else the first gallery) when its
   * heading keeps other blocks under it; otherwise that photo's whole section; and with no photo,
   * the first section whole, its heading over its words. A heading is never left alone. */
  beside?: boolean;
}) {
  // Sprint's photos run edge to edge (§9.6, ruling AC): a photo or gallery never shares a section
  // with text, so it can leave the column.
  const split = doc.style === 'sprint';
  type Entry = { block: StudioBlock; shown: ReactNode; heading: boolean };
  const sections: {
    id: string;
    entries: Entry[];
    list: boolean;
    /** Photos only (and a heading): how many, or -1 once another kind joins. */
    photos: number;
  }[] = [];
  for (const block of doc.blocks) {
    // A plain function (no hooks): called here so an empty block leaves no empty cell.
    const shown = Block({ block, style: doc.style, images });
    if (!shown) continue;
    const heading = block.kind === 'text' && block.variant === 'heading';
    const media = block.kind === 'photo' || block.kind === 'gallery';
    const last = sections.at(-1);
    const cut =
      split &&
      !heading &&
      last !== undefined &&
      // A photo after other blocks, or another block after photos, starts its own section.
      (media ? last.photos < 0 : last.photos > 0);
    if (heading || !sections.length || cut)
      sections.push({ id: block.id, entries: [], list: true, photos: 0 });
    const section = sections.at(-1)!;
    // A list section holds only lists (and its heading): a style may pair two side by side.
    if (!heading && block.kind !== 'services' && block.kind !== 'events')
      section.list = false;
    if (media) {
      if (section.photos >= 0) section.photos += 1;
    } else if (!heading) section.photos = -1;
    section.entries.push({ block, shown, heading });
  }
  // What sits beside Tiles' Tip tile: a block id, or a whole section's id.
  let besideBlock: string | undefined;
  let besideSection: string | undefined;
  if (beside && sections.length) {
    const all = sections.flatMap((sec) => sec.entries.map((e) => ({ sec, e })));
    const photo =
      all.find(({ e }) => e.block.kind === 'photo') ??
      all.find(({ e }) => e.block.kind === 'gallery');
    if (photo) {
      const headed = photo.sec.entries.some((e) => e.heading);
      const others = photo.sec.entries.filter(
        (e) => !e.heading && e !== photo.e,
      ).length;
      if (!headed || others > 0) besideBlock = photo.e.block.id;
      else besideSection = photo.sec.id;
    } else besideSection = sections[0]!.id;
  }
  const shown = part === 'lead' ? sections.slice(0, 1) : sections;
  if (!shown.length) return null;
  return (
    <div
      className={`studio-blocks${part === 'lead' ? ' studio-blocks--lead' : ''}`}
    >
      {shown.map((section, i) => (
        <div
          key={section.id}
          className="studio-section"
          {...(section.list && section.entries.length > 1
            ? { 'data-list': '' }
            : {})}
          {...(section.photos > 0 ? { 'data-media': '' } : {})}
          {...(lead && part === 'all' && i === 0 ? { 'data-lead': '' } : {})}
          {...(section.id === besideSection ? { 'data-beside': '' } : {})}
        >
          {section.entries.map(({ block, shown: cell }) => (
            <div
              key={block.id}
              className="studio-block"
              data-kind={block.kind}
              {...(block.id === besideBlock ? { 'data-beside': '' } : {})}
            >
              {cell}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
