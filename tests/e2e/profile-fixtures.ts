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
  plan: 'free',
  cover: { kind: 'design', design: 'danfo' },
  ...extra,
});

export const LONG_NAME =
  'Oluwatobiloba Adebayo-Akinwande Oghenekaro Chukwuemeka Ibekwe';
export const UNBROKEN_NAME = 'W'.repeat(60);
export const UNBROKEN_ROLE = 'R'.repeat(60);

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
  // Only what a page must have: no photo, role, bio or links.
  {
    handle: 'bareface',
    displayName: 'Ngozi Eze',
    acceptingTips: true,
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

export async function startStack(mode: Mode): Promise<Stack> {
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
