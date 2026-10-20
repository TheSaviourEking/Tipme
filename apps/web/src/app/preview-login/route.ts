import { createHash, timingSafeEqual } from 'node:crypto';
import { issuePreviewTicket, PREVIEW_TICKET_TTL_MS } from '@tipme/domain';
import { PREVIEW_COOKIE, safeReturnPath } from '@/lib/preview-gate';

const digest = (value: string) => createHash('sha256').update(value).digest();
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A small budget per server instance; the password itself is long and random.
let windowStart = Date.now();
let attempts = 0;

function page(next: string, error = '', status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>TipMe staging</title><style>body{font:18px Arial,Helvetica,sans-serif;margin:10vh auto;padding:24px;max-width:440px;color:#000;background:#fff}label{display:block;font-weight:700}input,button{box-sizing:border-box;width:100%;padding:14px;font:inherit;margin:12px 0}input{border:1px solid #777;border-radius:8px}button{background:#7A32F9;color:#fff;border:0;border-radius:8px;cursor:pointer}input:focus,button:focus{outline:3px solid #000;outline-offset:3px}.error{color:#9b0000;font-weight:700}</style></head><body><main><h1>TipMe staging</h1><p>Private test copy. All payments and messages are pretend.</p>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}<form method="post" action="/preview-login"><input type="hidden" name="next" value="${escape(next)}"><label for="password">Staging password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button type="submit">Open staging</button></form></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

export function GET(request: Request): Response {
  if (!process.env.PREVIEW_PASSWORD)
    return new Response('Not found', { status: 404 });
  return page(safeReturnPath(new URL(request.url).searchParams.get('next')));
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
    return page(next, 'Too many tries. Please wait a minute.', 429);
  const given = String(form?.get('password') ?? '');
  if (!timingSafeEqual(digest(given), digest(password)))
    return page(next, 'That password is not right.', 401);
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
