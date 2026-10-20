import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createGateway, issueTicket, validTicket } from './preview/gateway.mjs';

const password = 'test-only-preview-password-32-characters';
test('preview tickets expire, cannot be forged and change when the password rotates', () => {
  const ticket = issueTicket(password, 1000);
  assert.equal(validTicket(ticket, password, 1001), true);
  assert.equal(validTicket(ticket, password, 1000 + 12 * 3600_000), false);
  assert.equal(validTicket(ticket, password + 'x', 1001), false);
  assert.equal(validTicket(ticket + 'x', password, 1001), false);
  assert.equal(validTicket('', password, 1001), false);
});

test('gateway protects every route and forwards bearer tokens independently of its cookie', async (t) => {
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        path: req.url,
        auth: req.headers.authorization,
        cookie: req.headers.cookie,
        forwarded: req.headers['x-forwarded-for'],
      }),
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = upstream.address().port;
  const gateway = createGateway({
    password,
    origin: 'https://demo.example',
    apiPort: port,
    webPort: port,
    ready: () => true,
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => {
    gateway.closeAllConnections();
    gateway.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  for (const path of [
    '/',
    '/v1/dev/inbox',
    '/_next/test.js',
    '/api/revalidate',
    '/v1/tips/id/status',
  ]) {
    const response = await fetch(base + path, { redirect: 'manual' });
    assert.equal(response.status, 401, path);
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
  }
  assert.equal((await fetch(base + '/__preview/health')).status, 200);
  assert.equal(
    (
      await fetch(base + '/__preview/login', {
        method: 'POST',
        body: 'password=' + password,
        headers: { origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  const login = await fetch(base + '/__preview/login', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      origin: 'https://demo.example',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ password }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const response = await fetch(base + '/v1/tips/id/status', {
    headers: {
      cookie: cookie.split(';')[0] + '; tipme_session=recipient-session',
      authorization: 'Bearer receipt-secret',
      'x-forwarded-for': 'spoofed',
    },
  });
  const data = await response.json();
  assert.equal(data.auth, 'Bearer receipt-secret');
  assert.equal(data.cookie, 'tipme_session=recipient-session');
  assert.notEqual(data.forwarded, 'spoofed');
  const oversized = await fetch(base + '/__preview/login', {
    method: 'POST',
    headers: {
      origin: 'https://demo.example',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'x'.repeat(5000),
  });
  assert.equal(oversized.status, 413);
});
