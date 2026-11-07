import { createHmac } from 'node:crypto';

/**
 * How CI talks to TipMe's signed changelog routes (changelog plan, Design §3; the API side is
 * apps/api/src/changelog). No dependencies, so a workflow needs only Node, not `pnpm install`.
 *
 * The signature is `sha256=<hex of HMAC-SHA256(secret, "<unix seconds>." + exact body bytes)>`,
 * sent as X-TipMe-Signature with X-TipMe-Timestamp. The secret is never printed: errors name the
 * route and status only.
 */

/** The API reads changelog bodies raw up to this many bytes, and answers 413 past it. */
export const BODY_CAP_BYTES = 128 * 1024;
/** `changelogDraftSchema` limits, in UTF-16 code units (zod's string length). */
const TITLE_LIMIT = 256;
const BODY_LIMIT = 65_536;

export class ChangelogRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ChangelogRequestError';
    this.status = status;
  }
}

/** The two headers' values for `raw` (a string or Buffer), signed at `now` (milliseconds). */
export function sign(secret, raw, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(raw)
    .digest('hex');
  return { timestamp, signature: `sha256=${signature}` };
}

/** `text` cut to at most `limit` UTF-16 code units, never through a surrogate pair. */
function cutUnits(text, limit) {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

const bytesOf = (payload) => Buffer.byteLength(JSON.stringify(payload), 'utf8');

/**
 * The draft as it is sent: an empty body becomes null, the title fits the schema, and the body is
 * cut (keeping its start, whole characters only) so the request stays within the schema's
 * 65 536 characters and the API's 128 KiB. Characters outside ASCII take 2–4 bytes and JSON
 * escapes some to 6, so the cut is by the bytes actually sent, not by characters.
 */
export function draftPayload({
  number,
  title,
  body,
  mergeCommitSha,
  mergedAt,
}) {
  const payload = {
    number,
    title: cutUnits(title ?? '', TITLE_LIMIT),
    body: body ? cutUnits(body, BODY_LIMIT) : null,
    mergeCommitSha,
    mergedAt,
  };
  if (payload.body === null || bytesOf(payload) <= BODY_CAP_BYTES)
    return payload;
  // The longest prefix, in code points, whose request fits.
  const points = Array.from(payload.body);
  let fits = 0;
  let over = points.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (
      bytesOf({ ...payload, body: points.slice(0, middle).join('') }) <=
      BODY_CAP_BYTES
    )
      fits = middle;
    else over = middle;
  }
  const cut = points.slice(0, fits).join('');
  return { ...payload, body: cut || null };
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * POSTs `body` as JSON to `<api>/v1/webhooks/changelog/<route>`, signed, and returns the parsed
 * answer. Each try has a 10 s timeout. A network error, a timeout or a 5xx is tried once more
 * (re-signed); anything else is final. Throws ChangelogRequestError.
 */
export async function post(
  api,
  route,
  body,
  secret,
  { timeoutMs = 10_000, retryDelayMs = 2_000 } = {},
) {
  const url = `${String(api).replace(/\/+$/, '')}/v1/webhooks/changelog/${route}`;
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  let failure;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await wait(retryDelayMs);
    const { timestamp, signature } = sign(secret, raw);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tipme-timestamp': timestamp,
          'x-tipme-signature': signature,
        },
        body: raw,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError';
      failure = new ChangelogRequestError(
        `changelog ${route}: ${timedOut ? `timed out after ${timeoutMs} ms` : 'network error'}`,
        undefined,
      );
      continue;
    }
    if (response.ok) return response.json();
    await response.body?.cancel();
    if (response.status === 401) {
      throw new ChangelogRequestError(
        `changelog ${route}: signature refused (401). Check that CHANGELOG_SIGNING_SECRET is the same in the Actions secrets and on the server, and that the runner's clock is right.`,
        401,
      );
    }
    failure = new ChangelogRequestError(
      `changelog ${route}: TipMe answered ${response.status}`,
      response.status,
    );
    if (response.status < 500) throw failure;
  }
  throw failure;
}

/**
 * The secret and API URL from env, or null when either is missing: the feature is not switched on
 * yet (docs/runbooks/changelog.md), which is not a failure.
 */
export function settingsFrom(env) {
  const secret = env.CHANGELOG_SIGNING_SECRET?.trim();
  const api = env.CHANGELOG_API_URL?.trim();
  if (!secret || !api) {
    const missing = [
      !secret && 'the CHANGELOG_SIGNING_SECRET secret',
      !api && 'the CHANGELOG_API_URL variable',
    ].filter(Boolean);
    return { missing: missing.join(' and ') };
  }
  return { secret, api };
}
