#!/usr/bin/env node
// One-time setup for the release check's staff account on a copy (PR-010).
//
// 1. On the server, grant the role (prints a one-time enrolment code):
//      docker compose ... run --rm -e TIPME_CONFIRM_DATABASE=tipme migrate \
//        node packages/database/dist/scripts/grant-owner.js --phone <number> --role release_check
// 2. From your machine:
//      RELEASE_PREVIEW_PASSWORD=... node scripts/release-enrol.mjs --web <url> --api <url> \
//        --phone <number> --code <enrolment code>
//    It signs in through the pretend inbox, registers an authenticator and prints its secret once.
//    Store it as RELEASE_OPS_TOTP_SECRET wherever you run `pnpm release:check --full`.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const json = async (response, what) => {
  if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status}`);
  return response.status === 204 ? null : (await response.json()).data;
};

/** Signs in, enrols and confirms the authenticator; returns its secret (base32). */
export async function enrolReleaseStaff({
  web,
  api,
  password,
  phone,
  enrolmentCode,
}) {
  const { issuePreviewTicket, totpAt } =
    await import('../packages/domain/dist/index.js');
  const cookies = new Map();
  if (password)
    cookies.set('__Secure-tipme_preview', issuePreviewTicket(password));
  const call = async (method, path, body) => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: {
        origin: web,
        'x-tipme-csrf': '1',
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };
  await json(
    await call('POST', '/v1/auth/code', { phone }),
    'sending the sign-in code',
  );
  const inbox = await json(
    await call('GET', '/v1/dev/inbox'),
    'reading the pretend inbox',
  );
  const last4 = phone.replace(/\D/g, '').slice(-4);
  const code = /\b(\d{6})\b/.exec(
    inbox.find((m) => m.to.endsWith(last4) && /Your TipMe code is/.test(m.body))
      ?.body ?? '',
  )?.[1];
  if (!code) throw new Error('no sign-in code in the pretend inbox');
  await json(
    await call('POST', '/v1/auth/verify', {
      phone,
      code,
      deviceLabel: 'Release check',
    }),
    'signing in',
  );
  const { secret } = await json(
    await call('POST', '/v1/ops/enrol', { enrolmentCode }),
    'enrolling (is the code right and under 30 minutes old?)',
  );
  const step = BigInt(Math.floor(Date.now() / 30_000)) + BigInt(1);
  await json(
    await call('POST', '/v1/ops/enrol/confirm', { code: totpAt(secret, step) }),
    'confirming',
  );
  return secret;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      web: { type: 'string' },
      api: { type: 'string' },
      phone: { type: 'string' },
      code: { type: 'string' },
      insecure: { type: 'boolean', default: false },
    },
  });
  if (!values.web || !values.api || !values.phone || !values.code) {
    console.error(
      'usage: node scripts/release-enrol.mjs --web <url> --api <url> --phone <n> --code <enrolment code>',
    );
    process.exit(2);
  }
  if (values.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const secret = await enrolReleaseStaff({
      web: new URL(values.web).origin,
      api: new URL(values.api).origin,
      password: process.env.RELEASE_PREVIEW_PASSWORD ?? '',
      phone: values.phone,
      enrolmentCode: values.code,
    });
    console.log(
      'Authenticator registered. Store this as RELEASE_OPS_TOTP_SECRET (shown once):',
    );
    console.log(secret);
  } catch (error) {
    console.error(`Release enrolment failed: ${error.message}`);
    process.exit(1);
  }
}
