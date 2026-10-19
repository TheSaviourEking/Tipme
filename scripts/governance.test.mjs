import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve('scripts/check-governance.sh');
const required = [
  'AGENTS.md',
  'docs/00-DECISIONS.md',
  'docs/01-LOCAL-SETUP.md',
  'docs/03-DOMAIN-AND-PAYMENTS.md',
  'apps/web/AGENTS.md',
  'apps/api/AGENTS.md',
  'apps/worker/AGENTS.md',
  'packages/ui/AGENTS.md',
  'packages/contracts/AGENTS.md',
];

test('governance rejects suspected live credentials without printing their values', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tipme-governance-'));
  for (const file of required) {
    await mkdir(dirname(join(cwd, file)), { recursive: true });
    await writeFile(join(cwd, file), 'fixture');
  }
  const run = () => spawnSync('bash', [script], { cwd, encoding: 'utf8' });
  assert.equal(run().status, 0);
  const synthetic = ['sk', 'live', 'NOTAREALCREDENTIAL'].join('_');
  for (const filename of ['.env', '.env.local', 'development.env']) {
    await writeFile(join(cwd, filename), `EXAMPLE=${synthetic}\n`);
    const result = run();
    assert.equal(result.status, 1);
    assert.equal((result.stdout + result.stderr).includes(synthetic), false);
    await writeFile(join(cwd, filename), '');
  }
});
