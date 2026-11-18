import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { PublicProfile } from '../../packages/contracts/src/profiles';
import type { StudioDocumentV1 } from '../../packages/contracts/src/studio-document-v1';
import { API_ORIGIN, E2E_REVALIDATE_SECRET } from './stack';

// The e2e API runs one payment mode, and a web instance keeps its mode for a minute. So the page's
// other states run the real, built web app against a small stand-in for the two API routes it
// reads on the server. Browser calls still go to the e2e API.

export type Mode = 'test' | 'closed' | 'live';

// Not set in admin (owner, 14 Nov 2026, #216): the stand-in web keeps its own PILOT_NOTICE.
const DISPLAY = {
  pilotNotice: { set: false, on: false },
  launch: { set: false, at: null },
};
const RELEASE: Record<Mode, unknown> = {
  test: { paymentProvider: 'mock', paymentsLive: false, display: DISPLAY },
  closed: {
    paymentProvider: 'bachs-live',
    paymentsLive: false,
    display: DISPLAY,
  },
  live: { paymentProvider: 'bachs-live', paymentsLive: true, display: DISPLAY },
};

export const page = (
  handle: string,
  extra: Partial<PublicProfile> = {},
): PublicProfile => ({
  handle,
  displayName: 'Kemi Bello',
  role: 'Barber',
  bio: 'Fades, line-ups and good conversation.',
  links: [
    { platform: 'facebook', url: 'https://facebook.com/kemi' },
    { platform: 'instagram', url: 'https://instagram.com/kemi' },
    { platform: 'x', url: 'https://x.com/kemi' },
  ],
  phone: '+2348000000000',
  email: 'kemi@example.com',
  acceptingTips: true,
  // The API's answer for a live copy limited to named pages: this page is on the list.
  tippingOpen: true,
  plan: 'free',
  cover: { kind: 'design', design: 'danfo' },
  ...extra,
});

/** The board's three Studio pages (Kemi, Sule, Ify): /@studiokemi, /@studiosule, /@studioify. */
export const STUDIO_HANDLES = [
  'studiokemi',
  'studiosule',
  'studioify',
] as const;
export type StudioHandle = (typeof STUDIO_HANDLES)[number];

/**
 * The Studio documents and the contracts they need, loaded on first use: both are ES modules,
 * which this file's static imports can't load (as tests/e2e/studio-probes.ts).
 */
export async function studioFixtures() {
  const [contracts, examples, arbitrary] = await Promise.all([
    import('../../packages/contracts/dist/index.js'),
    import('../../packages/contracts/test/fixtures/studio-examples.mjs'),
    import('../../packages/contracts/test/support/studio-arbitrary.mjs'),
  ]);
  const docs: Record<StudioHandle, StudioDocumentV1> = {
    studiokemi: examples.KEMI as StudioDocumentV1,
    studiosule: examples.SULE as StudioDocumentV1,
    studioify: examples.IFY as StudioDocumentV1,
  };
  /**
   * A Pro page with a published design, as the API sends it while the switch is on (plan Task 8).
   * The photos are the Studio lab's generated images (served by the e2e build only), 2400 by
   * 1600 like the examples' check context.
   */
  const studioPage = (
    handle: string,
    document: StudioDocumentV1,
    extra: Partial<PublicProfile> = {},
  ): PublicProfile =>
    page(handle, {
      displayName: 'Kemi Adeyinka',
      craft: 'Songs about home, sung live.',
      note: 'Thank you for every visit.',
      plan: 'pro',
      links: [
        { platform: 'instagram', url: 'https://www.instagram.com/kemisings' },
        { platform: 'tiktok', url: 'https://www.tiktok.com/@kemisings' },
        { platform: 'youtube', url: 'https://www.youtube.com/@kemisings' },
        { platform: 'x', url: 'https://x.com/kemisings' },
      ],
      studio: {
        document,
        palette: contracts.deriveStudioPalette(document.brand),
        images: Object.fromEntries(
          (arbitrary.IMAGE_POOL as string[]).map((id) => [
            id,
            { path: `/dev/studio-lab/image/${id}`, width: 2400, height: 1600 },
          ]),
        ),
        checkVersion: contracts.DESIGN_CHECK_VERSION_V1,
      },
      ...extra,
    });
  const pages = [
    ...STUDIO_HANDLES.map((handle) => studioPage(handle, docs[handle])),
    // A design sent for a Free page (a stale answer): the page must stay standard.
    studioPage('studiofree', docs.studiokemi, { plan: 'free' }),
  ];
  return { contracts, docs, context: examples.EXAMPLE_CONTEXT, pages };
}

export const LONG_NAME =
  'Oluwatobiloba Adebayo-Akinwande Oghenekaro Chukwuemeka Ibekwe';
export const UNBROKEN_NAME = 'W'.repeat(60);
export const UNBROKEN_ROLE = 'R'.repeat(60);
/** Yoruba (Ẹ, ọ) and Hausa (Ɗ, ɗ) letters DM Serif Display and Manrope don't draw (17 Nov 2026). */
export const NIGERIAN_NAME = 'Ẹniọlá Ɗanɗaura';

/** A moment a page shared, as the API sends it. */
export const CELEBRATION = {
  momentId: '11111111-1111-4111-8111-111111111111',
  label: '10th tip',
};
const amounts = (...naira: number[]) => ({
  presetsMinor: naira.map((n) => String(n * 100)),
  minMinor: String(naira[0]! * 100),
});

export const PAGES: PublicProfile[] = [
  page('kemi'),
  page('hearts', {
    cover: { kind: 'design', design: 'large', colour: 'neutral' },
  }),
  page('propage', { plan: 'pro' }),
  // An API older than `links` sends the three fixed fields.
  page('oldlinks', {
    links: undefined,
    socials: {
      x: 'https://x.com/kemi',
      instagram: 'https://instagram.com/kemi',
    },
  }),
  // A Pro page with a featured link and its own website.
  page('prolinks', {
    plan: 'pro',
    links: [
      { platform: 'twitch', url: 'https://twitch.tv/kemi', featured: true },
      { platform: 'tiktok', url: 'https://tiktok.com/@kemi.cuts' },
      { platform: 'website', url: 'https://kemicuts.com' },
    ],
  }),
  page('waiting', { acceptingTips: false }),
  page('longname', {
    displayName: LONG_NAME,
    bio: 'A long bio that keeps on going. '.repeat(9).slice(0, 280),
  }),
  page('widename', { displayName: UNBROKEN_NAME }),
  page('eniola', {
    displayName: NIGERIAN_NAME,
    role: 'Aṣọ-ọkẹ weaver',
    tipAmounts: amounts(1_000, 2_000, 5_000, 10_000),
  }),
  page('widerole', { role: UNBROKEN_ROLE }),
  // The compact tip card's worst and usual cases: a page like DR7's, then more amounts.
  page('dr7', {
    displayName: 'DR7',
    avatarPath: '/portraits/tobi.webp',
    tipAmounts: amounts(10_000, 20_000, 50_000, 100_000),
    celebration: CELEBRATION,
  }),
  page('sixkeys', {
    tipAmounts: amounts(1_000, 2_000, 5_000, 10_000, 50_000, 100_000),
    celebration: CELEBRATION,
  }),
  page('fivekeys', {
    tipAmounts: amounts(1_000, 3_000, 5_000, 10_000, 100_000),
  }),
  page('eightkeys', {
    tipAmounts: amounts(
      1_000,
      1_500,
      3_000,
      5_000,
      10_000,
      20_000,
      50_000,
      100_000,
    ),
    celebration: CELEBRATION,
  }),
  page('tiekeys', { tipAmounts: amounts(1_500, 2_500, 9_000) }),
  page('tallpage', {
    bio: 'A long bio that keeps on going. '.repeat(9).slice(0, 280),
    craft: 'Fades. '.repeat(60),
    note: 'Thank you for every visit. '.repeat(40),
    celebration: CELEBRATION,
  }),
  page('closedout', { acceptingTips: false, celebration: CELEBRATION }),
  page('longfirst', {
    displayName: 'Oluwatobiloba-Adebayo-Akinwande Bello',
    celebration: CELEBRATION,
  }),
  // A live copy that takes tips only for named pages, and this one is not named.
  page('unlisted', { tippingOpen: false }),
  // Only what a page must have: no photo, role, bio or links.
  {
    handle: 'bareface',
    displayName: 'Ngozi Eze',
    acceptingTips: true,
    tippingOpen: true,
    plan: 'free',
    cover: { kind: 'design', design: 'scattered', colour: 'neutral' },
  },
];

export interface Stack {
  origin: string;
  /** Every profile lookup from now on: answered, a 503, or never answered. */
  setApi: (state: ApiState) => void;
  stop: () => Promise<void>;
}

export type ApiState = 'up' | 'failing' | 'hanging';

const portOf = (server: Server) => (server.address() as AddressInfo).port;

async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = portOf(server);
  await new Promise((done) => server.close(done));
  return port;
}

export async function startStack(
  mode: Mode,
  options: { pilotNotice?: boolean } = {},
): Promise<Stack> {
  let state: ApiState = 'up';
  const pages = [...PAGES, ...(await studioFixtures()).pages];
  const api = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stand-in');
    const handle = /^\/v1\/profiles\/(\w+)$/.exec(url.pathname)?.[1];
    if (handle && state === 'hanging') return;
    if (handle && state === 'failing') {
      response.statusCode = 503;
      response.end('{}');
      return;
    }
    const found = pages.find((p) => p.handle === handle);
    const answer = url.pathname === '/health/release' ? RELEASE[mode] : found;
    if (handle === 'oldname') {
      response.statusCode = 308;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { movedTo: 'kemi' } }));
      return;
    }
    response.statusCode = answer ? 200 : 404;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: answer ?? null }));
  });
  await new Promise<void>((done) => api.listen(0, '127.0.0.1', done));
  const port = await freePort();
  const web: ChildProcess = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '--port', String(port)],
    {
      cwd: resolve('apps/web'),
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'production',
        API_INTERNAL_ORIGIN: `http://127.0.0.1:${portOf(api)}`,
        NEXT_PUBLIC_API_ORIGIN: API_ORIGIN,
        WEB_REVALIDATE_SECRET: E2E_REVALIDATE_SECRET,
        ...(options.pilotNotice ? { PILOT_NOTICE: 'on' } : {}),
      },
    },
  );
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    web.kill();
    api.closeAllConnections();
    await new Promise((done) => api.close(done));
  };
  for (let tries = 0; tries < 120; tries += 1) {
    const up = await fetch(`${origin}/@kemi`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return { origin, setApi: (next) => (state = next), stop };
    await new Promise((done) => setTimeout(done, 500));
  }
  await stop();
  throw new Error(`web on ${origin} did not start`);
}
