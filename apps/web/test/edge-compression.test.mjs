import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { nextCompresses } from '../src/lib/edge-compression.ts';

// Next compresses its own answers wherever it serves browsers directly (next start, the e2e stack,
// review:screens). Only the self-hosted image, behind the edge that compresses, turns it off: the
// image's build says so (deploy/web.Dockerfile), and standalone keeps the config from that build.
test('Next compresses unless the build says the edge does', () => {
  assert.equal(nextCompresses({}), true);
  assert.equal(nextCompresses({ TIPME_EDGE_COMPRESSES: '' }), true);
  assert.equal(nextCompresses({ TIPME_EDGE_COMPRESSES: 'off' }), true);
  assert.equal(nextCompresses({ TIPME_EDGE_COMPRESSES: 'on' }), false);
});

test('next.config takes compress from it, and only the web image sets the flag, before its build', () => {
  const config = readFileSync(
    new URL('../next.config.ts', import.meta.url),
    'utf8',
  );
  assert.match(config, /compress: nextCompresses\(process\.env\)/);
  const dockerfile = readFileSync(
    new URL('../../../deploy/web.Dockerfile', import.meta.url),
    'utf8',
  );
  const set = dockerfile.indexOf('TIPME_EDGE_COMPRESSES=on');
  assert.ok(set > 0, 'the web image sets TIPME_EDGE_COMPRESSES=on');
  assert.ok(
    set < dockerfile.indexOf('pnpm turbo run build'),
    'before the build',
  );
  // turbo's strict env mode drops a variable it is not told about.
  const turbo = JSON.parse(
    readFileSync(new URL('../../../turbo.json', import.meta.url), 'utf8'),
  );
  assert.ok(turbo.tasks.build.env.includes('TIPME_EDGE_COMPRESSES'));
});
