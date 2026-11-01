import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function permissionsForJob(source, jobName) {
  const lines = source.split('\n');
  const jobStart = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(jobStart, -1, `job ${jobName} exists`);

  const jobEnd = lines.findIndex(
    (line, index) => index > jobStart && /^  [a-zA-Z0-9_-]+:$/.test(line),
  );
  const job = lines.slice(jobStart, jobEnd === -1 ? undefined : jobEnd);
  const permissionsStart = job.findIndex((line) => line === '    permissions:');
  assert.notEqual(
    permissionsStart,
    -1,
    `job ${jobName} declares its permissions`,
  );

  return new Map(
    job
      .slice(permissionsStart + 1)
      .filter((line) => /^      [a-z-]+: (read|write|none)$/.test(line))
      .map((line) => {
        const [, permission, level] = line.match(
          /^      ([a-z-]+): (read|write|none)$/,
        );
        return [permission, level];
      }),
  );
}

test('the staging caller grants every permission requested by reusable CI', () => {
  const staging = readFileSync('.github/workflows/deploy-staging.yml', 'utf8');
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const granted = permissionsForJob(staging, 'checks');
  const requested = permissionsForJob(ci, 'changes');
  const levels = { none: 0, read: 1, write: 2 };

  const missing = [...requested].filter(
    ([permission, level]) =>
      (levels[granted.get(permission) ?? 'none'] ?? 0) < levels[level],
  );

  assert.deepEqual(missing, []);
});
