import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { PublicProfile } from '../../packages/contracts/src/profiles';
import { API_ORIGIN, E2E_REVALIDATE_SECRET } from './stack';

// The e2e API runs one payment mode, and a web instance keeps its mode for a minute. So the page's
// other states run the real, built web app against a small stand-in for the two API routes it
// reads on the server. Browser calls still go to the e2e API.

export type Mode = 'test' | 'closed' | 'live';

const RELEASE: Record<Mode, unknown> = {
  test: { paymentProvider: 'mock', paymentsLive: false },
  closed: { paymentProvider: 'bachs-live', paymentsLive: false },
  live: { paymentProvider: 'bachs-live', paymentsLive: true },
};

export const page = (
  handle: string,
  extra: Partial<PublicProfile> = {},
): PublicProfile => ({
  handle,
  displayName: 'Kemi Bello',
  role: 'Barber',
  bio: 'Fades, line-ups and good conversation.',
  socials: {
    x: 'https://x.com/kemi',
    instagram: 'https://instagram.com/kemi',
    facebook: 'https://facebook.com/kemi',
  },
  phone: '+2348000000000',
  email: 'kemi@example.com',
  acceptingTips: true,
  // The API's answer for a live copy limited to named pages: this page is on the list.
  tippingOpen: true,
  plan: 'free',
  cover: { kind: 'design', design: 'danfo' },
  ...extra,
});

export const LONG_NAME =
  'Oluwatobiloba Adebayo-Akinwande Oghenekaro Chukwuemeka Ibekwe';
export const UNBROKEN_NAME = 'W'.repeat(60);
export const UNBROKEN_ROLE = 'R'.repeat(60);

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
  page('waiting', { acceptingTips: false }),
  page('longname', {
    displayName: LONG_NAME,
    bio: 'A long bio that keeps on going. '.repeat(9).slice(0, 280),
  }),
  page('widename', { displayName: UNBROKEN_NAME }),
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
  const api = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stand-in');
    const handle = /^\/v1\/profiles\/(\w+)$/.exec(url.pathname)?.[1];
    if (handle && state === 'hanging') return;
    if (handle && state === 'failing') {
      response.statusCode = 503;
      response.end('{}');
      return;
    }
    const found = PAGES.find((p) => p.handle === handle);
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
