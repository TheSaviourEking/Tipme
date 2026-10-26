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
const designDocs = [
  'DESIGN-CONSTITUTION',
  'REFERENCE-ANATOMY',
  'TOKENS-AND-MATERIALS',
  'TYPOGRAPHY',
  'COMPONENT-STANDARDS',
  'MOTION-AND-APPRECIATION',
  'RESPONSIVE-COMPOSITION',
  'ICONOGRAPHY',
  'VISUAL-QUALITY-GATE',
  'DECISION-LOG',
].map((name) => `docs/design/${name}.md`);

async function writeFixture(cwd) {
  for (const file of [...required, ...designDocs]) {
    await mkdir(dirname(join(cwd, file)), { recursive: true });
    await writeFile(join(cwd, file), 'fixture');
  }
  await writeFile(
    join(cwd, 'docs/design/DESIGN-CONSTITUTION.md'),
    '60% Physical Interface\n30% Editorial Interface\n10% Playful Interface\n#7A32F9 #FFFFFF #000000\n',
  );
  await writeFile(
    join(cwd, 'AGENTS.md'),
    'Read docs/design/DESIGN-CONSTITUTION.md before frontend work.\n',
  );
  await writeFile(
    join(cwd, 'apps/web/AGENTS.md'),
    'Read docs/design/DESIGN-CONSTITUTION.md before frontend work.\n',
  );
  await writeFile(
    join(cwd, 'packages/ui/AGENTS.md'),
    'Read docs/design/DESIGN-CONSTITUTION.md before frontend work.\n',
  );
}

test('governance rejects suspected live credentials without printing their values', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tipme-governance-'));
  await writeFixture(cwd);
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

test('governance requires the approved design authority and frontend instructions', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tipme-design-governance-'));
  for (const file of required) {
    await mkdir(dirname(join(cwd, file)), { recursive: true });
    await writeFile(join(cwd, file), 'fixture');
  }

  const run = () => spawnSync('bash', [script], { cwd, encoding: 'utf8' });
  assert.equal(run().status, 1, 'missing design authority must be rejected');

  await writeFixture(cwd);
  await writeFile(join(cwd, 'apps/web/AGENTS.md'), 'fixture');
  assert.equal(
    run().status,
    1,
    'missing web design instruction must be rejected',
  );

  await writeFixture(cwd);
  assert.equal(run().status, 0, 'complete design governance must pass');
});
