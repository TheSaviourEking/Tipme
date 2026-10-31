#!/usr/bin/env node
// Production watcher: checked every 5 minutes from GitHub Actions (watch-production.yml).
//   PRODUCTION_PAYMENTS_LIVE=true|false node scripts/watch-production.mjs --web <url> --api <url>
// Any problem is posted to ALERT_WEBHOOK_URL as {"text": "..."} (Slack-compatible) and the run
// fails, which also emails the repository owner. Messages name settings and the host, never values.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const TIMEOUT_MS = 10_000;

/** What is wrong with production, in plain words (empty = healthy). */
export async function checkProduction({
  web,
  api,
  expectLive,
  fetchImpl = fetch,
  timeoutMs = TIMEOUT_MS,
  log = console.log,
}) {
  const problems = [];
  const apiOrigin = new URL(api).origin;
  // A timeout or network error becomes status 0 (never a hang, never a crash).
  const call = async (url, init = {}) => {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, response };
    } catch {
      return { status: 0 };
    }
  };
  const json = async ({ status, response }) => {
    if (status !== 200) return null;
    try {
      return (await response.json()).data ?? null;
    } catch {
      return null;
    }
  };
  const answer = (status) => `HTTP ${status || 'no answer within 10 s'}`;

  // The activation state is decided by a person; an unset variable must not pass silently.
  const expected =
    expectLive === true || expectLive === 'true'
      ? true
      : expectLive === false || expectLive === 'false'
        ? false
        : null;
  if (expected === null)
    problems.push(
      'PRODUCTION_PAYMENTS_LIVE must be true or false: the live-payments check cannot run.',
    );

  const [ready, site, release, payments, webhook] = await Promise.all([
    call(`${apiOrigin}/health/ready`),
    call(new URL(web).origin + '/'),
    call(`${apiOrigin}/health/release`),
    call(`${apiOrigin}/health/payments`),
    call(`${apiOrigin}/v1/webhooks/bachs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  ]);

  if (ready.status !== 200)
    problems.push(`The API is not ready (${answer(ready.status)}).`);
  if (site.status !== 200)
    problems.push(`The web app is not answering (${answer(site.status)}).`);

  const info = await json(release);
  if (!info) problems.push('The release information could not be read.');
  else if (expected !== null && info.paymentsLive !== expected)
    problems.push(
      expected
        ? 'Payments are not live, but PRODUCTION_PAYMENTS_LIVE says they should be.'
        : 'Payments are LIVE, but PRODUCTION_PAYMENTS_LIVE says they should not be.',
    );

  if (payments.status === 404)
    log('Payment reserve not watched yet (/health/payments does not exist).');
  else {
    const reserve = await json(payments);
    if (!reserve)
      problems.push(
        `The payment reserve could not be read (${answer(payments.status)}).`,
      );
    else if (reserve.reserveLow)
      problems.push('The payment reserve is low: top it up.');
  }

  if (webhook.status !== 401)
    problems.push(
      `The Bachs webhook did not reject an unsigned call (${answer(webhook.status)}, expected 401).`,
    );
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { web: { type: 'string' }, api: { type: 'string' } },
  });
  if (!values.web || !values.api) {
    console.error(
      'usage: node scripts/watch-production.mjs --web <url> --api <url>',
    );
    process.exit(2);
  }
  const problems = await checkProduction({
    web: values.web,
    api: values.api,
    expectLive: process.env.PRODUCTION_PAYMENTS_LIVE,
  });
  if (problems.length === 0) {
    console.log('Production is healthy.');
    process.exit(0);
  }
  const text = `TipMe production (${new URL(values.api).host}) needs attention:\n${problems.map((p) => `• ${p}`).join('\n')}`;
  console.error(text);
  if (process.env.ALERT_WEBHOOK_URL)
    await fetch(process.env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => undefined);
  process.exit(1);
}
