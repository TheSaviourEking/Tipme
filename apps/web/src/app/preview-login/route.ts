import { createHash, timingSafeEqual } from 'node:crypto';
import { issuePreviewTicket, PREVIEW_TICKET_TTL_MS } from '@tipme/domain';
import { PREVIEW_COOKIE, safeReturnPath } from '@/lib/preview-gate';
import { previewLoginPage } from '@/lib/preview-login-page';

const digest = (value: string) => createHash('sha256').update(value).digest();

// A small budget per server instance; the password itself is long and random.
let windowStart = Date.now();
let attempts = 0;

export async function GET(request: Request): Promise<Response> {
  if (!process.env.PREVIEW_PASSWORD)
    return new Response('Not found', { status: 404 });
  return previewLoginPage({
    next: safeReturnPath(new URL(request.url).searchParams.get('next')),
  });
}

export async function POST(request: Request): Promise<Response> {
  const password = process.env.PREVIEW_PASSWORD;
  if (!password) return new Response('Not found', { status: 404 });
  const form = await request.formData().catch(() => null);
  const next = safeReturnPath(String(form?.get('next') ?? '/'));
  if (Date.now() - windowStart >= 60_000) {
    windowStart = Date.now();
    attempts = 0;
  }
  if (++attempts > 20)
    return previewLoginPage({
      next,
      error: 'Too many tries. Please wait a minute.',
      status: 429,
    });
  const given = String(form?.get('password') ?? '');
  if (!timingSafeEqual(digest(given), digest(password)))
    return previewLoginPage({
      next,
      error: 'That password is not right.',
      status: 401,
    });
  const domain = process.env.PREVIEW_COOKIE_DOMAIN;
  const cookie = [
    `${PREVIEW_COOKIE}=${issuePreviewTicket(password)}`,
    'Path=/',
    ...(domain ? [`Domain=${domain}`] : []),
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${PREVIEW_TICKET_TTL_MS / 1000}`,
  ].join('; ');
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      'set-cookie': cookie,
      'cache-control': 'no-store',
    },
  });
}
