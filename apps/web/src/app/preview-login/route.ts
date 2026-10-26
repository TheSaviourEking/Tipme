import { createHash, timingSafeEqual } from 'node:crypto';
import { issuePreviewTicket, PREVIEW_TICKET_TTL_MS } from '@tipme/domain';
import { PREVIEW_COOKIE, safeReturnPath } from '@/lib/preview-gate';
import { WORDMARK_PATHS, WORDMARK_VIEWBOX } from '@/lib/wordmark';

const digest = (value: string) => createHash('sha256').update(value).digest();
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A small budget per server instance; the password itself is long and random.
let windowStart = Date.now();
let attempts = 0;

function page(next: string, error = '', status = 200): Response {
  // Self-contained by design: the strict policy below allows inline styles only, so the logo
  // is inline SVG and the text uses the system interface font.
  const logo = `<svg class="logo" viewBox="${WORDMARK_VIEWBOX}" role="img" aria-label="TipMe">${WORDMARK_PATHS.map((path) => `<path d="${path.d}" fill="${path.fill}"/>`).join('')}</svg>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>TipMe staging</title><style>
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:#f3f2ee;color:#000;font:16px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:26rem;padding:32px;border:1px solid rgb(20 18 16/9%);border-radius:24px;background:#fffefa;box-shadow:0 1px 1px rgb(20 18 16/8%),0 8px 16px -6px rgb(20 18 16/10%),0 40px 72px -28px rgb(20 18 16/32%)}
.logo{display:block;height:36px;width:auto;margin:0 0 24px}
h1{margin:0 0 6px;font:400 30px/1.1 Georgia,"Iowan Old Style",serif;letter-spacing:-.02em}
p{margin:0 0 20px;color:#5d5a54}
label{display:block;margin:0 0 6px;font-size:14px;font-weight:700}
input{width:100%;min-height:50px;padding:12px 14px;border:1px solid rgb(20 18 16/14%);border-radius:14px;background:#eeede8;box-shadow:inset 0 1px 2px rgb(20 18 16/11%);font:inherit;color:inherit}
button{width:100%;min-height:50px;margin-top:16px;border:1px solid #000;border-radius:12px;background:#000;color:#fff;font:inherit;font-weight:700;cursor:pointer;box-shadow:0 1px 1px rgb(20 18 16/24%),0 8px 16px -8px rgb(20 18 16/45%)}
input:focus,button:focus{outline:3px solid #7a32f9;outline-offset:3px}
.error{margin:0 0 16px;padding:12px 14px;border-radius:12px;background:#fdecea;color:#9b2820;font-weight:700}
</style></head><body><main>${logo}<h1>TipMe staging</h1><p>Private test copy. All payments and messages are pretend.</p>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}<form method="post" action="/preview-login"><input type="hidden" name="next" value="${escape(next)}"><label for="password">Staging password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button type="submit">Open staging</button></form></main></body></html>`;
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
