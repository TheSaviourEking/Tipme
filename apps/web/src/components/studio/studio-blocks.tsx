import {
  SOCIAL_PLATFORMS,
  embedUrl,
  linkHandle,
  parseVideoLink,
  tileWidth,
  type PublicStudio,
  type SocialLink,
  type StudioBlock,
  type StudioDocument,
  type StudioRow,
} from '@tipme/contracts';
import { LinkBadge } from '@/components/profile/link-badge';
import { formatNaira } from '@/lib/demo-amount';
import {
  studioFont,
  studioImageSources,
  type StudioShape,
} from './studio-theme';
import { VideoEmbed } from './video-embed';

/** What every block needs besides itself. */
export interface StudioRenderContext {
  doc: StudioDocument;
  images: PublicStudio['images'];
  profile: { bio?: string; links: SocialLink[]; firstName: string };
  /** Photos that load straight away (studioEagerImages); the rest load lazily. */
  eager: Set<string>;
}

/** The cell a block sits in, for its photos' `sizes`. */
export interface StudioCellPlace {
  row: StudioRow;
  /** CSS px of the cell on a 1023px and a 1440px screen; a phone uses the screen less padding. */
  tablet: number;
  desktop: number;
  phoneInset: number;
}

const external = {
  rel: 'noopener noreferrer nofollow ugc',
  target: '_blank',
} as const;
const NEW_TAB = ' (opens in a new tab)';

/** Whether this font lacks a letter of `text`, so it is set in the page's text font instead. */
export function needsTextFont(fontId: string, text: string): boolean {
  const font = studioFont(fontId);
  return (
    font.missing.length > 0 &&
    [...text].some((c) => font.missing.includes(c.codePointAt(0) ?? 0))
  );
}

function sizesFor(place: StudioCellPlace, scale = 1): string {
  const px = (n: number) => `${Math.round(n * scale)}px`;
  return `(max-width: 767px) calc((100vw - ${place.phoneInset}px) * ${scale}), (max-width: 1023px) ${px(place.tablet)}, ${px(place.desktop)}`;
}

function Photo({
  imageId,
  alt,
  shape,
  sizes,
  eager,
  ctx,
}: {
  imageId: string;
  alt: string;
  shape: StudioShape;
  sizes: string;
  eager: boolean;
  ctx: StudioRenderContext;
}) {
  const image = ctx.images[imageId];
  if (!image) return null;
  const { src, srcSet, width, height } = studioImageSources(image, shape);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- TipMe's own renditions, already sized
    <img
      src={src}
      srcSet={srcSet}
      sizes={sizes}
      width={width}
      height={height}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
    />
  );
}

const SHAPE = {
  square: 'square',
  circle: 'square',
  wide: 'wide',
  tall: 'tall',
} as const;

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

/**
 * One block. Every piece of user text is React text (never HTML). A block with nothing to show
 * renders nothing: the design check refuses to publish one, and this is the read-side net.
 */
export function StudioBlockView({
  block: b,
  place,
  ctx,
}: {
  block: StudioBlock;
  place: StudioCellPlace;
  ctx: StudioRenderContext;
}) {
  const headingFont = (text: string) =>
    needsTextFont(ctx.doc.fonts.heading, text) ? ' studio-text-font' : '';
  switch (b.kind) {
    case 'text': {
      if (!b.text) return null;
      if (b.variant === 'heading') {
        const Tag = b.level === 3 ? 'h3' : 'h2';
        return (
          <Tag
            className={`studio-heading studio-text${headingFont(b.text)}`}
            data-level={b.level ?? 2}
          >
            {b.text}
          </Tag>
        );
      }
      if (b.variant === 'lead')
        return <p className="studio-lead studio-text">{b.text}</p>;
      return (
        <div className="studio-paragraph">
          {b.text.split('\n\n').map((part, i) => (
            <p key={i} className="studio-text">
              {part}
            </p>
          ))}
        </div>
      );
    }
    case 'photo': {
      if (!ctx.images[b.imageId]) return null;
      return (
        <figure className="studio-photo" data-shape={b.variant}>
          <Photo
            imageId={b.imageId}
            alt={b.decorative ? '' : b.alt}
            shape={SHAPE[b.variant]}
            sizes={sizesFor(place)}
            eager={ctx.eager.has(b.id)}
            ctx={ctx}
          />
          {b.caption && (
            <figcaption className="studio-photo__caption studio-scrim studio-text">
              {b.caption}
            </figcaption>
          )}
        </figure>
      );
    }
    case 'gallery': {
      const images = b.images.filter((i) => ctx.images[i.imageId]);
      if (!images.length) return null;
      const scale = (first: boolean) =>
        tileWidth(1000, b.variant, first) / 1000;
      return (
        <ul className="studio-gallery" data-variant={b.variant}>
          {images.map((image, i) => (
            <li key={`${image.imageId}-${i}`}>
              <Photo
                imageId={image.imageId}
                alt={image.decorative ? '' : image.alt}
                shape="square"
                sizes={sizesFor(place, scale(i === 0))}
                eager={ctx.eager.has(`${b.id}:${i}`)}
                ctx={ctx}
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
        <div className="studio-services" data-variant={b.variant}>
          <ul>
            {b.items.map((item, i) => (
              <li
                key={i}
                className={b.variant === 'cards' ? 'studio-card' : undefined}
              >
                <span className="studio-services__name studio-text">
                  {item.name}
                </span>
                {item.detail && (
                  <span className="studio-services__detail studio-text">
                    {item.detail}
                  </span>
                )}
                <span className="studio-price">
                  {item.from ? 'from ' : ''}
                  {formatNaira(item.priceMinor)}
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
        <ul className="studio-events" data-variant={b.variant}>
          {b.items.map((item, i) => {
            const when = weekday(item.date);
            const line = [item.time ? clock(item.time) : null, item.place]
              .filter(Boolean)
              .join(' · ');
            return (
              <li
                key={i}
                className={b.variant === 'cards' ? 'studio-card' : undefined}
              >
                <time className="studio-date" dateTime={item.date}>
                  <span>{when.day}</span>
                  <span className="studio-date__day">{when.date}</span>
                  <span>{when.month}</span>
                </time>
                <span className="studio-events__words">
                  <span className="studio-events__title studio-text">
                    {item.title}
                  </span>
                  {line && (
                    <span className="studio-events__line studio-text">
                      {line}
                    </span>
                  )}
                  {item.note && (
                    <span className="studio-events__line studio-text">
                      {item.note}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      );
    case 'links':
      if (!ctx.profile.links.length) return null;
      return (
        <ul
          className="studio-links"
          data-variant={b.variant}
          aria-label={`Find ${ctx.profile.firstName} elsewhere`}
        >
          {ctx.profile.links.map((link) => {
            const { label } = SOCIAL_PLATFORMS[link.platform];
            const handle = linkHandle(link);
            return (
              <li key={link.url}>
                <a className="studio-button" href={link.url} {...external}>
                  <LinkBadge platform={link.platform} small />
                  <span className="studio-text">
                    {b.variant === 'buttons' ? label : (handle ?? label)}
                    {b.variant === 'buttons' && handle ? (
                      <span className="studio-links__handle"> {handle}</span>
                    ) : null}
                  </span>
                  <span className="sr-only">{NEW_TAB}</span>
                </a>
              </li>
            );
          })}
        </ul>
      );
    case 'quote':
      if (!b.text) return null;
      return (
        <blockquote className="studio-quote" data-variant={b.variant}>
          <p className={`studio-text${headingFont(b.text)}`}>{b.text}</p>
        </blockquote>
      );
    case 'about':
      if (!ctx.profile.bio) return null;
      return <p className="studio-about studio-text">{ctx.profile.bio}</p>;
    case 'supporters':
      // Task 13 (its own switch); the schema refuses it until then.
      return null;
  }
}
