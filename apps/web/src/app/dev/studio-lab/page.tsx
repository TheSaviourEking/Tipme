import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { inflateRawSync } from 'node:zlib';
import {
  STUDIO_FONTS,
  deriveStudioPalette,
  resolveCover,
  resolveStudio,
  DESIGN_CHECK_VERSION,
  type PublicProfile,
  type SocialLink,
  type StudioFontId,
} from '@tipme/contracts';
import { AppreciationForm } from '@/components/appreciation-form';
import { ProfileCover } from '@/components/profile/cover';
import { RecipientIdentity } from '@/components/profile/recipient-card';
import { ReportPage } from '@/components/report-page';
import { StudioPage } from '@/components/studio/studio-page';
import { LAB_IMAGES, STUDIO_EXAMPLES, fontSpecimen } from './examples';
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
 */
export default async function StudioLabPage({ searchParams }: Props) {
  // Rendered per request: the lab reads today's Lagos date (to keep today's events), which
  // Next.js refuses to read while prerendering ("unstable value `new Date()`").
  await connection();
  if (!studioLabOpen()) notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? q[k] : undefined);
  let raw: unknown;
  const example = one('example');
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
  const document = resolveStudio(
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
          checkVersion: DESIGN_CHECK_VERSION,
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
