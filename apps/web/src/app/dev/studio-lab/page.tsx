import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { inflateRawSync } from 'node:zlib';
import {
  STUDIO_ACCENT_IDS,
  STUDIO_COVER_TYPES,
  STUDIO_STYLE_IDS,
  checkDesign,
  resolveCover,
  resolveStudio,
  studioTokens,
  visibleLinks,
  DESIGN_CHECK_VERSION,
  type PublicProfile,
  type SocialLink,
  type StudioDocument,
  type StudioStyleId,
} from '@tipme/contracts';
import { AppreciationForm } from '@/components/appreciation-form';
import { ProfileCover } from '@/components/profile/cover';
import { RecipientIdentity } from '@/components/profile/recipient-card';
import { ReportPage } from '@/components/report-page';
import { renderStyled } from '@/components/studio-styles/style-page';
import {
  LAB_IMAGES,
  LAB_LONG_NAMES,
  LAB_STYLE_EXAMPLES,
  labStyleExample,
} from './examples';
import { studioLabOpen } from './lab-gate';

// A harness that renders whatever document the test sends: always rendered on request.
export const instant = false;

export const metadata: Metadata = {
  title: 'Studio lab',
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const LINKS: SocialLink[] = [
  { platform: 'instagram', url: 'https://www.instagram.com/kemisings' },
  { platform: 'tiktok', url: 'https://www.tiktok.com/@kemisings' },
  { platform: 'youtube', url: 'https://www.youtube.com/@kemisings' },
  { platform: 'x', url: 'https://x.com/kemisings' },
  { platform: 'twitch', url: 'https://www.twitch.tv/kemisings' },
  { platform: 'soundcloud', url: 'https://soundcloud.com/kemisings' },
  { platform: 'audiomack', url: 'https://audiomack.com/kemisings' },
  { platform: 'telegram', url: 'https://t.me/kemisings' },
];

/** The Lagos date, so events dated today still show. */
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(
    new Date(),
  );

/**
 * Page Studio lab: renders a v2 document with the real style renderer around the real tip form
 * with its style's skin, for the render property tests and the curated examples. Test copies only.
 *   ?style=<id> (LAB_STYLE_EXAMPLES), &mode=light|dark|auto, &accent=<id>, &cover=yours|gradient|plain,
 *   &doc=<a v2 (or v1, migrated) document, deflate-raw JSON as base64url, at most 12 KB>,
 *   &name=<display name>, &links=0..8, &bio=0|1,
 *   &yours=photo|small|upload|single|design|automatic|animated (the Settings cover: the generated
 *   photo, the same photo said to be 640 × 360, a generated 2240 × 600 WebP stored like the API's
 *   with its 640/1080/1600 renditions, the same file without renditions, a design, the automatic
 *   one, an animation)
 *   ?example=styles-min|styles-max|long-names|hostile (&style=<id>, Clear by default)
 */
export default async function StudioLabPage({ searchParams }: Props) {
  // Rendered per request: the lab reads today's Lagos date (to keep today's events), which
  // Next.js refuses to read while prerendering ("unstable value `new Date()`").
  await connection();
  if (!studioLabOpen()) notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? q[k] : undefined);
  if (one('style') === undefined && !one('example') && !one('doc')) notFound();
  return <StyleLab one={one} />;
}

const pick = <T extends string>(
  value: string | undefined,
  from: readonly T[],
): T | undefined =>
  value !== undefined && (from as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

function decodeDoc(doc: string): unknown {
  if (!doc || doc.length > 16_384) notFound();
  try {
    return JSON.parse(
      inflateRawSync(Buffer.from(doc, 'base64url'), {
        maxOutputLength: 1_000_000,
      }).toString('utf8'),
    );
  } catch {
    notFound();
  }
}

/**
 * The styles harness (PR 2a): a v2 document through StudioStylePage, around the real tip form
 * with its style's skin, with the design check's notices listed under the page. The lab's
 * profile has a generated cover photo and no avatar (initials), so no person's picture is used.
 */
function StyleLab({ one }: { one: (k: string) => string | undefined }) {
  const style = pick(one('style') ?? 'clear', STUDIO_STYLE_IDS);
  if (!style) notFound();
  const example = one('example');
  const docParam = one('doc');
  let document: StudioDocument | null;
  if (docParam) document = resolveStudio(decodeDoc(docParam), today());
  else if (example) document = labStyleExample(example, style);
  else document = LAB_STYLE_EXAMPLES[style] ?? null;
  if (!document) notFound();
  document = { ...document, style };
  const mode = pick(one('mode'), ['light', 'dark', 'auto'] as const);
  if (mode) document.mode = mode;
  const accent = pick(one('accent'), STUDIO_ACCENT_IDS);
  if (accent) document.accent = accent;
  const cover = pick(one('cover'), STUDIO_COVER_TYPES);
  if (cover) document.cover = cover;
  // Run through the resolver again, so a cover the style doesn't offer becomes "Your cover".
  document = resolveStudio(document, today());
  const bio = one('bio') !== '0';
  const handle = 'studiolab';
  const plan = 'pro' as const;
  const links = visibleLinks(
    LINKS.slice(0, Math.max(0, Math.min(8, Number(one('links') ?? 5) || 0))),
    plan,
  );
  const name =
    one('name') ??
    (example === 'long-names' ? LAB_LONG_NAMES[0] : 'Kemi Adeyinka');
  const profile: PublicProfile = {
    handle,
    displayName: name,
    role: 'Singer and songwriter, Lagos',
    ...(bio
      ? {
          bio: 'I write songs about home and the people in it. Every tip goes into studio time.',
        }
      : {}),
    links,
    plan,
    acceptingTips: true,
    cover: { kind: 'photo', path: `/dev/studio-lab/image/${LAB_IMAGES[29]}` },
  };
  // The Settings cover ("Your cover"): the generated photo by default.
  const yours =
    pick(one('yours'), [
      'photo',
      'small',
      'upload',
      'single',
      'design',
      'automatic',
      'animated',
    ] as const) ?? 'photo';
  const settingsCover =
    yours === 'photo' ||
    yours === 'small' ||
    yours === 'upload' ||
    yours === 'single'
      ? null
      : resolveCover({
          handle,
          coverPath: null,
          coverDesign: yours === 'design' ? 'scattered' : null,
          coverColour: null,
          coverAnimation: yours === 'animated' ? 'drift' : null,
          plan,
        });
  if (settingsCover) profile.cover = settingsCover;
  // The API's shape for an uploaded cover with its renditions (or, ?yours=single, without).
  if (yours === 'upload')
    profile.cover = {
      kind: 'photo',
      path: '/dev/studio-lab/cover/1.webp',
      widths: [640, 1080, 1600],
    };
  if (yours === 'single')
    profile.cover = { kind: 'photo', path: '/dev/studio-lab/cover/1.webp' };
  const coverSize =
    yours === 'small'
      ? { width: 640, height: 360 }
      : { width: 2400, height: 1600 };
  const firstName = name.split(/\s+/)[0] ?? name;
  const images = Object.fromEntries(
    LAB_IMAGES.map((id) => [
      id,
      { path: `/dev/studio-lab/image/${id}`, width: 2400, height: 1600 },
    ]),
  );
  const check = checkDesign(document, {
    images: Object.fromEntries(
      LAB_IMAGES.map((id) => [
        id,
        { width: 2400, height: 1600, bytes: 120_000 },
      ]),
    ),
    videos: {},
    profile: { name, bio, links: links.length },
    plan,
    coverKind:
      yours === 'small' || yours === 'upload' || yours === 'single'
        ? 'photo'
        : yours,
    hasAvatar: false,
  });
  const styled = renderStyled({
    studio: {
      document,
      images,
      palette: studioTokens(style as StudioStyleId, document.accent),
      checkVersion: DESIGN_CHECK_VERSION,
    },
    profile,
    coverSize,
    coverArt: (
      <ProfileCover
        cover={
          settingsCover ??
          resolveCover({
            handle,
            coverPath: null,
            coverDesign: null,
            coverColour: null,
          })
        }
        priority
      />
    ),
    // Classic keeps TipMe's identity block (the new styles draw their own).
    identity: <RecipientIdentity profile={profile} firstName={firstName} />,
    tipBlock: (
      <AppreciationForm
        surface="profile"
        paymentMode="test"
        recipient={firstName}
        handle={handle}
        // Classic has no skin: its tip form is today's.
        {...(style === 'classic' ? {} : { skin: style })}
      />
    ),
    footer: (
      <footer className="profile-foot">
        <div className="profile-foot__quiet">
          <ReportPage handle={handle} />
          <Link href="/legal/privacy">Privacy</Link>
          <Link href="/legal/terms">Terms</Link>
        </div>
      </footer>
    ),
  });
  // Classic renders today's page, whose root is its own <main>.
  return (
    <>
      {style === 'classic' ? (
        styled
      ) : (
        <main id="main" tabIndex={-1} className="studio-lab">
          {styled}
        </main>
      )}
      {check.notices.length + check.issues.length > 0 && (
        <aside className="studio-lab-check" aria-label="Design check">
          <ul>
            {[...check.issues, ...check.notices].map((item, i) => (
              <li key={i} data-rule={item.rule}>
                {item.message}
              </li>
            ))}
          </ul>
        </aside>
      )}
    </>
  );
}
