import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { PublicProfile } from '../../packages/contracts/src/profiles';
import type { StudioDocument } from '../../packages/contracts/src/studio-document';
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

/** The board's three Studio pages (Kemi, Sule, Ify), converted to v2: /@studiokemi, … */
export const STUDIO_HANDLES = [
  'studiokemi',
  'studiosule',
  'studioify',
] as const;
export type StudioHandle = (typeof STUDIO_HANDLES)[number];

/** The nine styles (styles spec §9), in the canvas's order. */
export const STYLE_IDS = [
  'classic',
  'clear',
  'journal',
  'stage',
  'signboard',
  'sprint',
  'tiles',
  'linen',
  'horizon',
] as const;
export type StyleId = (typeof STYLE_IDS)[number];
/** One published page per style: /@styleclassic, /@styleclear, … (ruling R6). */
export const STYLE_HANDLES = STYLE_IDS.map((id) => `style${id}` as const);

/** The Settings cover kinds "Your cover" draws (§13, §14.8), for /@cover<style><kind>. */
export const COVER_KINDS = [
  'photo',
  'upload',
  'design',
  'automatic',
  'animated',
] as const;

/** The covers each style offers (contracts STUDIO_STYLES[…].covers): Signboard and Sprint have no gradient. */
const coversOf = (style: StyleId) =>
  style === 'signboard' || style === 'sprint'
    ? (['yours', 'plain'] as const)
    : (['yours', 'gradient', 'plain'] as const);

/**
 * A page sharing a moment ("Celebrating Kemi's 10th tip") in every style, mode and cover, and on
 * Classic in today's purple and a chosen accent: /@cel<style>[<accent>]<mode><cover>.
 */
export interface CelebrationCase {
  handle: string;
  style: StyleId;
  mode: 'light' | 'dark' | 'auto';
  cover: 'yours' | 'gradient' | 'plain';
  /** Classic only: null is today's purple. Other styles keep their default accent. */
  accent?: 'green' | null;
}
export const CELEBRATION_CASES: CelebrationCase[] = STYLE_IDS.flatMap((style) =>
  (style === 'classic' ? ([null, 'green'] as const) : [undefined]).flatMap(
    (accent) =>
      coversOf(style).flatMap((cover) =>
        (['light', 'dark', 'auto'] as const).map((mode) => ({
          handle: `cel${style}${accent === undefined ? '' : (accent ?? 'purple')}${mode}${cover}`,
          style,
          mode,
          cover,
          ...(accent === undefined ? {} : { accent }),
        })),
      ),
  ),
);

/** The lab's generated images (the e2e build serves them), 2400 × 1600 like the examples. */
const labImage = (n: number) =>
  `0000${n.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
const LAB_COVER = `/dev/studio-lab/image/${labImage(29)}`;
/** An uploaded cover as the API sends it, with its renditions (PR #279); never served here. */
export const API_COVER_PATH =
  '/v1/covers/33333333-3333-4333-8333-333333333333/1.webp';

/** Each style's published example: the lab's (examples.ts `styleExample`), as v2. */
function styleDocument(
  style: StyleId,
  extra: Partial<StudioDocument> = {},
): StudioDocument {
  const natural: Partial<Record<StyleId, Partial<StudioDocument>>> = {
    // Classic shows an accent, so it is a design (with every default it is today's page).
    classic: { accent: 'green' },
    journal: { cover: 'plain' },
    stage: { mode: 'dark' },
    signboard: { cover: 'plain' },
    tiles: { cover: 'plain' },
  };
  return {
    v: 2,
    style,
    accent: null,
    mode: 'light',
    cover: 'yours',
    blocks: [
      {
        id: 'labhead1',
        kind: 'text',
        variant: 'heading',
        text: 'Studio diary',
      },
      {
        id: 'labtext1',
        kind: 'text',
        variant: 'paragraph',
        text: 'Eight songs, a four-piece band and a small room in Yaba. Tips pay for studio hours and the session players.',
      },
      {
        id: 'labgall1',
        kind: 'gallery',
        images: [1, 2, 3].map((n, i) => ({
          imageId: labImage(n),
          alt: [
            'Rehearsal, warm stage light',
            'Vocal booth under blue light',
            'Morning session by the window',
          ][i]!,
        })),
      },
      { id: 'labhead2', kind: 'text', variant: 'heading', text: 'Kind words' },
      {
        id: 'labquot1',
        kind: 'quote',
        text: 'The best night of live music I’ve had in Lagos this year.',
      },
    ],
    ...natural[style],
    ...extra,
  };
}

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
  // The board's v1 documents as the API reads them now (§7.1; pinned in studio-v1-to-v2.json).
  const today = '2026-11-14';
  const docs: Record<string, StudioDocument> = {
    studiokemi: contracts.resolveStudio(examples.KEMI, today),
    studiosule: contracts.resolveStudio(examples.SULE, today),
    studioify: contracts.resolveStudio(examples.IFY, today),
  };
  /**
   * A page with a published design, as the API sends it while the switch is on (styles plan Task
   * 10): v2, as its plan shows it, with the palette the API computes. The photos are the lab's
   * generated images (served by the e2e build only), 2400 by 1600.
   */
  const studioPage = (
    handle: string,
    document: StudioDocument,
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
      // "Your cover": the lab's generated photo (Classic draws today's cover, so a design).
      cover:
        document.style === 'classic'
          ? { kind: 'design', design: 'danfo' }
          : { kind: 'photo', path: LAB_COVER },
      studio: {
        document,
        palette: contracts.studioTokens(document.style, document.accent),
        images: Object.fromEntries(
          (arbitrary.IMAGE_POOL as string[]).map((id) => [
            id,
            { path: `/dev/studio-lab/image/${id}`, width: 2400, height: 1600 },
          ]),
        ),
        checkVersion: contracts.DESIGN_CHECK_VERSION,
      },
      ...extra,
    });
  for (const style of STYLE_IDS) docs[`style${style}`] = styleDocument(style);
  const settingsCovers = {
    photo: { kind: 'photo', path: LAB_COVER },
    upload: {
      kind: 'photo',
      path: API_COVER_PATH,
      widths: [640, 1080, 1600],
    },
    design: { kind: 'design', design: 'danfo' },
    automatic: contracts.resolveCover({
      handle: 'coverauto',
      coverPath: null,
      coverDesign: null,
      coverColour: null,
    }),
    animated: { kind: 'animated', animation: 'drift', play: 'loop' },
  } as const satisfies Record<
    (typeof COVER_KINDS)[number],
    PublicProfile['cover']
  >;
  const pages = [
    ...Object.entries(docs).map(([handle, doc]) => studioPage(handle, doc)),
    // A page with nothing on it but the person and the tip form, in each style: the shortest page
    // there is, for the footer-grounded spec (the footer rests at the bottom of the screen).
    ...STYLE_IDS.map((style) =>
      studioPage(`short${style}`, styleDocument(style, { blocks: [] }), {
        links: [],
        bio: undefined,
        craft: undefined,
        note: undefined,
      }),
    ),
    // The same pages without links: no links area, and no "See links" (§8, §14.8).
    ...STYLE_IDS.map((style) =>
      studioPage(`style${style}nolinks`, styleDocument(style), { links: [] }),
    ),
    // "Your cover" with each Settings cover kind, in Clear and in Stage (needsPhoto).
    ...(['clear', 'stage'] as const).flatMap((style) =>
      COVER_KINDS.map((kind) =>
        studioPage(`cover${style}${kind}`, styleDocument(style), {
          cover: settingsCovers[kind],
        }),
      ),
    ),
    // Today's page with an uploaded cover and its renditions: it must not use them.
    page('standardupload', { cover: settingsCovers.upload }),
    // A Free page whose published style is Pro (lapsed): visitors see Classic (§12.5).
    studioPage('stylelapsed', styleDocument('stage', { accent: 'coral' }), {
      plan: 'free',
      cover: { kind: 'design', design: 'danfo' },
    }),
    // Classic with every choice at its default: today's page (§9.1), beside its twin with none.
    studioPage(
      'classicplain',
      styleDocument('classic', { accent: null, blocks: [] }),
      {
        cover: { kind: 'design', design: 'danfo' },
      },
    ),
    studioPage('classictwin', styleDocument('classic'), {
      cover: { kind: 'design', design: 'danfo' },
      studio: undefined,
    }),
    // A shared moment in every style, mode and cover (celebration-style.spec.ts).
    ...CELEBRATION_CASES.map(({ handle, style, mode, cover, accent }) =>
      studioPage(
        handle,
        styleDocument(style, {
          mode,
          cover,
          ...(accent === undefined ? {} : { accent }),
        }),
        { celebration: CELEBRATION },
      ),
    ),
    // The same moment on a Free page: Classic in dark purple, and a lapsed Pro style (Stage, dark).
    studioPage(
      'celclassicfreedark',
      styleDocument('classic', { accent: null, mode: 'dark' }),
      { plan: 'free', celebration: CELEBRATION },
    ),
    studioPage('cellapseddark', styleDocument('stage', { mode: 'dark' }), {
      plan: 'free',
      cover: { kind: 'design', design: 'danfo' },
      celebration: CELEBRATION,
    }),
    // Today's page (no design) on a Pro plan; sixkeys is its Free twin.
    page('celstandardpro', { plan: 'pro', celebration: CELEBRATION }),
    // Classic's other states in each mode (lilac-audit.spec.ts): paused, and not open on this copy.
    ...(['light', 'dark'] as const).flatMap((mode) => [
      studioPage(
        `classicpaused${mode}`,
        styleDocument('classic', { accent: null, mode }),
        { acceptingTips: false },
      ),
      studioPage(
        `classicunlisted${mode}`,
        styleDocument('classic', { accent: null, mode }),
        { tippingOpen: false },
      ),
    ]),
    // A stale answer: Pro extras only (photo accent and a gallery on Classic) for a Free page.
    studioPage(
      'studiofree',
      styleDocument('classic', {
        accent: 'photo',
        blocks: [styleDocument('classic').blocks[2]!],
      }),
      { plan: 'free' },
    ),
  ];
  return { contracts, docs, pages };
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
  // The footer-grounded spec's shortest Classic pages: a one-line bio, with a cover and with none
  // (an older API sends no cover at all).
  page('shortcover', { bio: 'Barber.' }),
  page('shortnocover', { bio: 'Barber.', cover: undefined }),
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
