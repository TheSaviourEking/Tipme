import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';

const COOKIE = '__Host-tipme_preview';
const TTL = 12 * 3600_000;
const digest = (value) => createHash('sha256').update(value).digest();
const equal = (left, right) => timingSafeEqual(digest(left), digest(right));
const signature = (value, password) =>
  createHmac('sha256', password)
    .update(`tipme-preview:${value}`)
    .digest('base64url');
export function issueTicket(password, now = Date.now()) {
  const expires = String(now + TTL);
  return `${expires}.${signature(expires, password)}`;
}
export function validTicket(ticket, password, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 100) return false;
  const [expires, mac] = ticket.split('.');
  return (
    /^\d{13}$/.test(expires ?? '') &&
    Number(expires) > now &&
    Number(expires) <= now + TTL &&
    equal(mac ?? '', signature(expires, password))
  );
}
const loginPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TipMe private demo</title><style>body{font:18px system-ui;margin:10vh auto;padding:24px;max-width:440px;color:#000}input,button{box-sizing:border-box;width:100%;padding:14px;font:inherit;margin:12px 0}button{background:#7A32F9;color:white;border:0;border-radius:8px}input:focus,button:focus{outline:3px solid #000;outline-offset:3px}</style><main><h1>TipMe private demo</h1><p>For invited testers. All payments are pretend. Use fictional details: demo inboxes are shared.</p><form method="post" action="/__preview/login"><label for="password">Demo password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button>Open demo</button></form></main></html>`;

/** Only this gateway binds externally. The application processes stay on loopback. */
export function createGateway({
  password,
  origin,
  apiPort = 4000,
  webPort = 3000,
  ready = () => true,
}) {
  if (typeof password !== 'string' || password.length < 32)
    throw new Error('PREVIEW_PASSWORD must have at least 32 characters');
  if (new URL(origin).protocol !== 'https:')
    throw new Error('Preview origin must use HTTPS');
  // A global budget avoids trusting spoofable forwarding headers and bounds memory use.
  let windowStart = Date.now();
  let attempts = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const end = (status, body) => {
      res.statusCode = status;
      res.end(body);
    };
    const raw = req.url ?? '/';
    if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\r\n]/.test(raw))
      return end(400, 'Invalid path');
    const path = new URL(raw, origin).pathname;
    if (path === '/__preview/health' && req.method === 'GET')
      return end(ready() ? 200 : 503, ready() ? 'ready' : 'starting');
    if (path === '/__preview/login' && req.method === 'POST') {
      if (req.headers.origin !== origin) return end(403, 'Origin refused');
      if (
        !req.headers['content-type']?.startsWith(
          'application/x-www-form-urlencoded',
        )
      )
        return end(415, 'Unsupported form');
      if (Date.now() - windowStart >= 60_000) {
        windowStart = Date.now();
        attempts = 0;
      }
      if (++attempts > 20) {
        res.setHeader('Retry-After', '60');
        return end(429, 'Please try again in a minute');
      }
      let body = '';
      try {
        for await (const chunk of req) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 4096) return end(413, 'Form too large');
        }
      } catch {
        return end(400, 'Invalid form');
      }
      if (!equal(new URLSearchParams(body).get('password') ?? '', password))
        return end(401, 'Incorrect demo password. Go back and try again.');
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=${issueTicket(password)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
      );
      res.setHeader('Location', '/');
      return end(303, '');
    }
    const cookies = (req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim());
    const ticket = cookies
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!validTicket(ticket, password)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      return end(401, loginPage);
    }
    if (!ready()) return end(503, 'Demo is starting. Please retry shortly.');
    const headers = { ...req.headers };
    for (const key of Object.keys(headers)) {
      if (
        key.startsWith('x-forwarded-') ||
        [
          'forwarded',
          'connection',
          'upgrade',
          'proxy-authorization',
          'proxy-connection',
          'transfer-encoding',
        ].includes(key)
      )
        delete headers[key];
    }
    // Preserve recipient cookies and bearer receipts, but do not expose the gateway credential downstream.
    const appCookies = cookies
      .filter((part) => !part.startsWith(`${COOKIE}=`))
      .join('; ');
    if (appCookies) headers.cookie = appCookies;
    else delete headers.cookie;
    headers.host = new URL(origin).host;
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? '127.0.0.1';
    const upstream = request(
      {
        hostname: '127.0.0.1',
        port: path.startsWith('/v1/') ? apiPort : webPort,
        path: raw,
        method: req.method,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, {
          ...response.headers,
          'x-robots-tag': 'noindex, nofollow, noarchive',
          'cache-control': 'no-store',
        });
        response.pipe(res);
      },
    );
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) end(502, 'Demo temporarily unavailable');
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}
