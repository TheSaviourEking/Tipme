import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { inflateRawSync } from 'node:zlib';
import {
  STUDIO_ACCENT_IDS,
  STUDIO_COVER_TYPES,
  STUDIO_FONTS,
  STUDIO_STYLE_IDS,
  checkDesign,
  deriveStudioPalette,
  resolveCover,
  resolveStudio,
  resolveStudioV1,
  studioTokens,
  visibleLinks,
  DESIGN_CHECK_VERSION,
  DESIGN_CHECK_VERSION_V1,
  type PublicProfile,
  type SocialLink,
  type StudioDocument,
  type StudioFontId,
  type StudioStyleId,
} from '@tipme/contracts';
import { AppreciationForm } from '@/components/appreciation-form';
import { ProfileCover } from '@/components/profile/cover';
import { RecipientIdentity } from '@/components/profile/recipient-card';
import { ReportPage } from '@/components/report-page';
import { StudioPage } from '@/components/studio/studio-page';
import { renderStyled } from '@/components/studio-styles/style-page';
import {
  LAB_IMAGES,
  LAB_LONG_NAMES,
  LAB_STYLE_EXAMPLES,
  STUDIO_EXAMPLES,
  fontSpecimen,
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
 * Page Studio lab (plan Task 6): renders any Studio document with the real renderer around the
 * real tip block, for the render property tests and the curated examples. Test copies only.
 *   ?example=kemi|sule|ify|max|min|empty|hostile, or ?example=fonts&font=<id>
 *   ?doc=<base64url deflate-raw JSON, at most 12 KB>
 *   &mode=light|dark (overrides the document's), &bio=0|1, &links=0..8, &today=YYYY-MM-DD
 * Page Studio styles (v2, spec 2026-11-17-page-studio-styles), rendered by StudioStylePage:
 *   ?style=<id> (LAB_STYLE_EXAMPLES), &mode=light|dark|auto, &accent=<id>, &cover=yours|gradient|plain,
 *   &doc=<a v2 document, encoded as above>, &name=<display name>, &links=0..8, &bio=0|1
 *   ?example=styles-min|styles-max|long-names (&style=<id>, Clear by default), or
 *   ?example=hostile&style=<id> (v2; without &style it is the v1 document)
 */
export default async function StudioLabPage({ searchParams }: Props) {
  // Rendered per request: the lab reads today's Lagos date (to keep today's events), which
  // Next.js refuses to read while prerendering ("unstable value `new Date()`").
  await connection();
  if (!studioLabOpen()) notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? q[k] : undefined);
  const example = one('example');
  if (
    one('style') !== undefined ||
    (example && ['styles-min', 'styles-max', 'long-names'].includes(example))
  )
    return <StyleLab one={one} />;
  let raw: unknown;
  if (example === 'fonts') {
    const font = STUDIO_FONTS.find((f) => f.id === one('font'));
    if (!font) notFound();
    raw = fontSpecimen(font.id as StudioFontId);
  } else if (example) {
    if (!(example in STUDIO_EXAMPLES)) notFound();
    raw = STUDIO_EXAMPLES[example as keyof typeof STUDIO_EXAMPLES];
  } else {
    const doc = one('doc') ?? '';
    if (!doc || doc.length > 16_384) notFound();
    try {
      raw = JSON.parse(
        inflateRawSync(Buffer.from(doc, 'base64url'), {
          maxOutputLength: 1_000_000,
        }).toString('utf8'),
      );
    } catch {
      notFound();
    }
  }
  // &today=YYYY-MM-DD pins the date events are kept against, so a screenshot never ages.
  const day = one('today');
  const document = resolveStudioV1(
    raw,
    day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : today(),
  );
  const mode = one('mode');
  if (mode === 'light' || mode === 'dark') document.mode = mode;
  const bio = one('bio') !== '0';
  const links = Math.max(0, Math.min(8, Number(one('links') ?? 4) || 0));
  const handle = 'studiolab';
  const profile: PublicProfile = {
    handle,
    displayName: one('name') ?? 'Kemi Adeyinka',
    role: 'Singer and songwriter, Lagos',
    ...(bio
      ? {
          bio: 'I write songs about home and the people in it. Every tip goes into studio time.',
        }
      : {}),
    links: LINKS.slice(0, links),
    plan: 'pro',
    acceptingTips: true,
  };
  // The identity shows name, photo, handle and role; the bio and links are Studio blocks here.
  const identityProfile: PublicProfile = {
    handle: profile.handle,
    displayName: profile.displayName,
    ...(profile.role ? { role: profile.role } : {}),
    plan: 'pro',
  };
  const firstName = profile.displayName.split(/\s+/)[0] ?? profile.displayName;
  const images = Object.fromEntries(
    LAB_IMAGES.map((id) => [
      id,
      { path: `/dev/studio-lab/image/${id}`, width: 2400, height: 1600 },
    ]),
  );
  return (
    <main id="main" tabIndex={-1} className="studio-lab">
      <StudioPage
        studio={{
          document,
          palette: deriveStudioPalette(document.brand),
          images,
          checkVersion: DESIGN_CHECK_VERSION_V1,
        }}
        profile={profile}
        cover={
          <ProfileCover
            cover={resolveCover({
              handle,
              coverPath: null,
              coverDesign: null,
              coverColour: null,
            })}
            priority
          />
        }
        identity={
          <RecipientIdentity profile={identityProfile} firstName={firstName} />
        }
        tipBlock={
          <AppreciationForm
            surface="profile"
            paymentMode="test"
            recipient={firstName}
            handle={handle}
          />
        }
        footer={
          <footer className="profile-foot">
            <div className="profile-foot__quiet">
              <ReportPage handle={handle} />
              <Link href="/legal/privacy">Privacy</Link>
              <Link href="/legal/terms">Terms</Link>
            </div>
          </footer>
        }
      />
    </main>
  );
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
    coverKind: 'photo',
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
    coverArt: (
      <ProfileCover
        cover={resolveCover({
          handle,
          coverPath: null,
          coverDesign: null,
          coverColour: null,
        })}
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
