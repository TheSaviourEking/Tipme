import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  newTotpSecret,
  otpauthUrl,
  totpAt,
  verifyTotp,
} from '../dist/index.js';

// RFC 6238 appendix B, SHA-1 key "12345678901234567890", truncated to 6 digits.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const stepOf = (seconds) => BigInt(Math.floor(seconds / 30));

test('codes match the RFC 6238 SHA-1 vectors', () => {
  assert.equal(totpAt(RFC_SECRET, stepOf(59)), '287082');
  assert.equal(totpAt(RFC_SECRET, stepOf(1111111109)), '081804');
  assert.equal(totpAt(RFC_SECRET, stepOf(1234567890)), '005924');
  assert.equal(totpAt(RFC_SECRET, stepOf(2000000000)), '279037');
});

test('one step either side is accepted; two steps away is refused', () => {
  const now = new Date(1_800_000_000_000);
  const step = stepOf(now.getTime() / 1000);
  for (const offset of [-1n, 0n, 1n]) {
    const result = verifyTotp(
      RFC_SECRET,
      totpAt(RFC_SECRET, step + offset),
      now,
      null,
    );
    assert.deepEqual(result, { ok: true, step: step + offset });
  }
  for (const offset of [-2n, 2n])
    assert.deepEqual(
      verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + offset), now, null),
      { ok: false },
    );
});

test('a code from the last used step, or earlier, is refused (no reuse)', () => {
  const now = new Date(1_800_000_000_000);
  const step = stepOf(now.getTime() / 1000);
  const code = totpAt(RFC_SECRET, step);
  assert.deepEqual(verifyTotp(RFC_SECRET, code, now, step), {
    ok: false,
    reused: true,
  });
  assert.deepEqual(
    verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1n), now, step),
    { ok: false, reused: true },
  );
  assert.deepEqual(
    verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1n), now, step),
    { ok: true, step: step + 1n },
  );
});

test('malformed codes are refused', () => {
  const now = new Date(1_800_000_000_000);
  for (const bad of ['', '12345', '1234567', 'abcdef', ' 287082'])
    assert.deepEqual(verifyTotp(RFC_SECRET, bad, now, null), { ok: false });
});

test('new secrets are 20 random bytes in base32, and the otpauth link names TipMe Admin', () => {
  const a = newTotpSecret();
  assert.match(a, /^[A-Z2-7]{32}$/);
  assert.notEqual(a, newTotpSecret());
  const url = new URL(otpauthUrl(a, '•••0002'));
  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.host, 'totp');
  assert.equal(url.searchParams.get('secret'), a);
  assert.equal(url.searchParams.get('issuer'), 'TipMe Admin');
  assert.equal(url.searchParams.get('digits'), '6');
  assert.equal(url.searchParams.get('period'), '30');
  assert.match(decodeURIComponent(url.pathname), /^\/TipMe Admin:/);
});

test('a code from a step already used says so; any other wrong code does not', () => {
  const now = new Date(1_700_000_000_000);
  const step = BigInt(Math.floor(now.getTime() / 30_000));
  const used = totpAt(RFC_SECRET, step);
  assert.deepEqual(verifyTotp(RFC_SECRET, used, now, step), {
    ok: false,
    reused: true,
  });
  const other = used === '000000' ? '000001' : '000000';
  assert.deepEqual(verifyTotp(RFC_SECRET, other, now, step), { ok: false });
});
