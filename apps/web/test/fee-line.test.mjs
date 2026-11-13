import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feeLine, followsCurrentRule } from '../src/lib/fee-line.ts';

test('the tip detail’s fee line says what was actually taken', () => {
  // Today's rule: TipMe's 10%, processing paid from it.
  assert.deepEqual(feeLine('17000', '3000'), {
    label: 'TipMe fee (includes processing)',
    minor: '20000',
  });
  // Given the gross, the label names the real share, not a fixed one.
  assert.deepEqual(feeLine('17000', '3000', '200000'), {
    label: 'TipMe fee (10%, includes processing)',
    minor: '20000',
  });
  assert.deepEqual(feeLine('7000', '3000', '200000'), {
    label: 'TipMe fee (5%, includes processing)',
    minor: '10000',
  });
  assert.deepEqual(feeLine('14000', '1000', '200000'), {
    label: 'TipMe fee (7.5%, includes processing)',
    minor: '15000',
  });
  // An older fee-free tip: TipMe took nothing; only the provider's processing came off.
  assert.deepEqual(feeLine('0', '3000'), {
    label: 'Payment processing (TipMe’s fee waived)',
    minor: '3000',
  });
  // A fee-free tip under today's rule: nothing came off.
  assert.deepEqual(feeLine('0', '0'), {
    label: 'TipMe fee (waived)',
    minor: '0',
  });
});

test('only a tip priced under the current rule says "includes processing"', () => {
  // Current rule, 10%: processing is paid from TipMe's share.
  assert.equal(
    feeLine('17000', '3000', '200000', true).label,
    'TipMe fee (10%, includes processing)',
  );
  // Current rule, a staff-set 7.5%.
  assert.equal(
    feeLine('12000', '3000', '200000', true).label,
    'TipMe fee (7.5%, includes processing)',
  );
  // Waived under the current rule.
  assert.equal(feeLine('0', '0', '200000', true).label, 'TipMe fee (waived)');
  // An older policy (10% plus processing on top): no share, never "includes processing".
  const old = feeLine('20000', '3000', '200000', false);
  assert.equal(old.label, 'TipMe fee and payment processing');
  assert.equal(old.minor, '23000');
  assert.ok(!old.label.includes('includes processing'));
});

test('a tip priced under any "processing included" policy (old 10%, Free 7%, Pro 5%) keeps that label', () => {
  // Owner, 12 Nov 2026: tips before the switch keep their recorded 10%. The quote writer records
  // the policy's version alone or with its suffixes; every one of these pays processing from the share.
  const versions = ['proposed-v1.1', 'v2-free-7pct', 'v2-pro-5pct'];
  for (const v of [
    'proposed-v1.1',
    'proposed-v1.1-custom-750',
    'proposed-v1.1-fee-free',
    'proposed-v1.1-custom-750-fee-free',
    'v2-free-7pct',
    'v2-free-7pct-custom-600',
    'v2-free-7pct-fee-free',
    'v2-pro-5pct',
    'v2-pro-5pct-custom-300-fee-free',
  ])
    assert.equal(followsCurrentRule(v, versions), true, v);
  // Older rules, and versions that merely start with the same characters.
  for (const v of [
    'mock-v0',
    'mock-v1',
    'test',
    'proposed-v1.10',
    'proposed-v1.1x',
    'v2-free-7pctx',
    'v2-pro-5pct2',
  ])
    assert.equal(followsCurrentRule(v, versions), false, v);
  // Each tip shows the rate it really paid, from its own amounts.
  const label = (platform, provider, gross, version) =>
    feeLine(platform, provider, gross, followsCurrentRule(version, versions)).label;
  // An old 10% tip, after the switch: unchanged.
  assert.equal(
    label('17000', '3000', '200000', 'proposed-v1.1'),
    'TipMe fee (10%, includes processing)',
  );
  assert.equal(
    label('11000', '3000', '200000', 'v2-free-7pct'),
    'TipMe fee (7%, includes processing)',
  );
  assert.equal(
    label('7000', '3000', '200000', 'v2-pro-5pct'),
    'TipMe fee (5%, includes processing)',
  );
  // An odd amount still reads as its plan's whole rate (₦2,000.50 at 7%: ₦140.04 rounded).
  assert.equal(
    label('11003', '3001', '200050', 'v2-free-7pct'),
    'TipMe fee (7%, includes processing)',
  );
});

test('the tip detail passes every "processing included" version from the domain, not only the current one', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(
    new URL('../src/app/dashboard/tips/[tipId]/tip-view.tsx', import.meta.url),
    'utf8',
  );
  assert.match(src, /followsCurrentRule\(\s*tip\.feePolicyVersion,\s*PROCESSING_INCLUDED_FEE_VERSIONS/);
});
