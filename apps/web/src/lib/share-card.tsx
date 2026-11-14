import { readFile } from 'node:fs/promises';
import type { ImageResponseOptions } from 'next/server';
import {
  COVER_COLOURS,
  type PublicProfile,
  type ResolvedCover,
} from '@tipme/contracts';
import { HEART_MARK, WORDMARK_PATHS, WORDMARK_VIEWBOX } from '@/lib/wordmark';
import { characterMap, setsIn } from '@/lib/font-cmap';
import { avatarSource } from '@/lib/avatar-source';

// The link-preview cards (1200 × 630), drawn by next/og. Both are request-independent drawings of
// what they are given: the general card of nothing, the person card of `PersonCardInput` and the
// photo the route fetched for it (`shareCardPhoto`), only.

export interface PersonCardInput {
  name: string;
  role: string | null;
  handle: string;
  /** The photo the public page shows (an API path or a demo picture), or null. */
  avatarPath: string | null;
  band: string;
  face: string;
}

const PAPER = '#f3f2ee'; // --canvas
const INK = '#000000';
const SECONDARY = '#5d5a54'; // --text-secondary
const BRAND = '#7a32f9';
// The Violet cover colour: TipMe purple and its deeper tone.
const PURPLE = { band: BRAND, face: '#5415c9' } as const;

/**
 * Only what the public page shows: never phone, email, tips, totals or balance. The photo is the
 * page's own: the API sends it only for a live, active page that has one (a removed photo has no
 * path), and only a path the page itself would show is kept.
 */
export function personCardInput(p: PublicProfile): PersonCardInput {
  const role = p.role?.trim();
  const photo = p.avatarPath;
  return {
    name: p.displayName,
    role: role ? role : null,
    handle: p.handle,
    avatarPath: photo && avatarSource(photo, '', '') ? photo : null,
    ...shareCardColours(p.cover),
  };
}

/** The cover's colour (COVER_COLOURS base and tone); a photo or colourless cover uses TipMe purple. */
export function shareCardColours(cover: ResolvedCover | undefined): {
  band: string;
  face: string;
} {
  const id = cover && cover.kind !== 'photo' ? cover.colour : undefined;
  const colour = id ? COVER_COLOURS.find((c) => c.id === id) : undefined;
  return colour ? { band: colour.base, face: colour.tone } : { ...PURPLE };
}

/** The first letters of the first and last words, as whole letters (accents kept). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = (word: string) => {
    const [letter] = new Intl.Segmenter('en', { granularity: 'grapheme' })
      .segment(word)
      [Symbol.iterator]();
    return (letter?.segment ?? '').toLocaleUpperCase('en');
  };
  const head = words[0] ?? '';
  const tail = words.length > 1 ? (words.at(-1) ?? '') : '';
  return first(head) + (tail ? first(tail) : '');
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** White letters where they read at 3:1 or better (large type), otherwise black. */
function inkOn(hex: string): string {
  return 1.05 / (luminance(hex) + 0.05) >= 3 ? '#ffffff' : INK;
}

function Heart({ size, fill }: { size: number; fill: string }) {
  return (
    <svg width={size} height={size} viewBox={HEART_MARK.viewBox}>
      <path d={HEART_MARK.d} transform={HEART_MARK.transform} fill={fill} />
    </svg>
  );
}

/** A raised key with the heart: purple on the general card, black on a person's. */
function HeartKey({ size, colour }: { size: number; colour: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: size * 0.27,
        backgroundColor: colour,
        backgroundImage:
          'linear-gradient(180deg, rgba(255,255,255,0.24) 0%, rgba(255,255,255,0) 42%)',
        boxShadow:
          '0 2px 0 rgba(20,18,16,0.18), 0 18px 36px rgba(20,18,16,0.18)',
      }}
    >
      <Heart size={size * 0.86} fill="#ffffff" />
    </div>
  );
}

function Wordmark({ width }: { width: number }) {
  return (
    <svg width={width} height={(width * 293) / 778} viewBox={WORDMARK_VIEWBOX}>
      {WORDMARK_PATHS.map((path) => (
        <path key={path.d.slice(0, 24)} d={path.d} fill={path.fill} />
      ))}
    </svg>
  );
}

export function GeneralCard() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'stretch',
        padding: 72,
        backgroundColor: PAPER,
        color: INK,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <Wordmark width={170} />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            fontFamily: 'DM Serif Display',
            fontSize: 96,
            lineHeight: 1.04,
            letterSpacing: -1.5,
          }}
        >
          <span>A little thanks</span>
          <span style={{ color: BRAND }}>goes a long way.</span>
        </div>
        <span
          style={{
            fontFamily: 'Manrope',
            fontWeight: 600,
            fontSize: 30,
            color: SECONDARY,
          }}
        >
          For the people who make a difference.
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <HeartKey size={232} colour={BRAND} />
      </div>
    </div>
  );
}

const BAND_HEIGHT = 168;
const FACE = 152;
const FACE_RING = 8;

/** The face's letters and the name are in DM Serif when it draws all of them, else in Manrope. */
const SERIF = { fontFamily: 'DM Serif Display', fontWeight: 400 } as const;
const SANS = { fontFamily: 'Manrope', fontWeight: 700 } as const;

export function PersonCard(
  p: PersonCardInput & {
    host: string;
    /** DM Serif Display's characters (`serifCharacters`); without it the name is set in DM Serif. */
    serif?: ReadonlySet<number>;
    /** The photo as a data URL (`shareCardPhoto`); without it, the initials. */
    photo?: string | null;
  },
) {
  const initials = initialsOf(p.name);
  const face = !p.serif || setsIn(initials, p.serif) ? SERIF : SANS;
  const name = !p.serif || setsIn(p.name, p.serif) ? SERIF : SANS;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        backgroundColor: PAPER,
        color: INK,
      }}
    >
      {/* The cover band, in the cover's colour. */}
      <div
        style={{
          display: 'flex',
          width: '100%',
          height: BAND_HEIGHT,
          backgroundColor: p.band,
          backgroundImage:
            'linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0) 60%)',
        }}
      />
      {/*
        The face: the person's photo when they have one, else their initials (owner, 14 Nov 2026;
        this was initials only before). The photo is the one their public page shows.
      */}
      <div
        style={{
          position: 'absolute',
          top: BAND_HEIGHT - (FACE + 2 * FACE_RING) / 2,
          left: 72 - FACE_RING,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: FACE + 2 * FACE_RING,
          height: FACE + 2 * FACE_RING,
          borderRadius: 999,
          border: `${FACE_RING}px solid ${PAPER}`,
          backgroundColor: p.face,
          color: inkOn(p.face),
          ...face,
          fontSize: 64,
        }}
      >
        {p.photo ? (
          // next/og draws a plain img; alt text is not part of the picture.
          // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
          <img
            src={p.photo}
            width={FACE}
            height={FACE}
            style={{
              width: FACE,
              height: FACE,
              borderRadius: 999,
              objectFit: 'cover',
            }}
          />
        ) : (
          initials
        )}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          justifyContent: 'space-between',
          padding: '116px 72px 48px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'block',
              ...name,
              fontSize: 68,
              lineHeight: 1.06,
              letterSpacing: -1,
              lineClamp: 2,
              wordBreak: 'break-word',
            }}
          >
            {p.name}
          </div>
          {p.role ? (
            <div
              style={{
                display: 'block',
                marginTop: 10,
                fontFamily: 'Manrope',
                fontWeight: 600,
                fontSize: 32,
                lineHeight: 1.3,
                color: SECONDARY,
                lineClamp: 1,
                wordBreak: 'break-word',
              }}
            >
              {p.role}
            </div>
          ) : null}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              fontFamily: 'Manrope',
              fontWeight: 700,
              fontSize: 30,
              color: INK,
            }}
          >
            {`${p.host}/@${p.handle}`}
          </span>
          <HeartKey size={80} colour={INK} />
        </div>
      </div>
    </div>
  );
}

let serifMap: ReadonlySet<number> | undefined;
let fonts: Promise<NonNullable<ImageResponseOptions['fonts']>> | undefined;

/** The two fonts as TrueType, read once per process. */
export function ogFonts(): Promise<NonNullable<ImageResponseOptions['fonts']>> {
  fonts ??= Promise.all([
    readFile(
      new URL('../fonts/og/DMSerifDisplay-Regular.ttf', import.meta.url),
    ),
    readFile(new URL('../fonts/og/Manrope-SemiBold.ttf', import.meta.url)),
    readFile(new URL('../fonts/og/Manrope-Bold.ttf', import.meta.url)),
  ]).then(([serif, semibold, bold]) => {
    serifMap = characterMap(serif);
    return [
      {
        name: 'DM Serif Display',
        data: serif,
        weight: 400 as const,
        style: 'normal' as const,
      },
      {
        name: 'Manrope',
        data: semibold,
        weight: 600 as const,
        style: 'normal' as const,
      },
      {
        name: 'Manrope',
        data: bold,
        weight: 700 as const,
        style: 'normal' as const,
      },
    ];
  });
  // A failed read must not stay cached: the next card tries again.
  fonts.catch(() => {
    fonts = undefined;
  });
  return fonts;
}

/** The characters DM Serif Display draws, read from the same file as `ogFonts`. */
export async function serifCharacters(): Promise<ReadonlySet<number>> {
  await ogFonts();
  return serifMap ?? new Set();
}
