import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const LEVELS = { none: 0, read: 1, write: 2 };

/** The permissions a job declares, by job name, from a workflow's top-level `jobs:` block. */
function jobPermissions(source) {
  const lines = source.split('\n');
  const jobs = new Map();
  let job = null;
  let inPermissions = false;
  for (const line of lines.slice(lines.indexOf('jobs:') + 1)) {
    const name = line.match(/^ {2}([a-zA-Z0-9_-]+):$/);
    if (name) {
      job = name[1];
      jobs.set(job, new Map());
      inPermissions = false;
    } else if (/^ {4}permissions:$/.test(line)) {
      inPermissions = true;
    } else if (inPermissions) {
      const entry = line.match(/^ {6}([a-z-]+): (read|write|none)$/);
      if (entry) jobs.get(job).set(entry[1], entry[2]);
      else if (line.trim() && !line.trim().startsWith('#'))
        inPermissions = false;
    }
  }
  return jobs;
}

// GitHub validates every job of a called workflow before anything starts, even jobs that would be
// skipped, so the caller must grant the highest level any of them asks for.
test('the staging caller grants every permission requested by any job of reusable CI', () => {
  const staging = readFileSync('.github/workflows/deploy-staging.yml', 'utf8');
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const granted = jobPermissions(staging).get('checks');
  assert.ok(granted?.size, 'the checks job declares its permissions');

  const missing = [];
  for (const [job, requested] of jobPermissions(ci)) {
    for (const [permission, level] of requested) {
      if (LEVELS[granted.get(permission) ?? 'none'] < LEVELS[level])
        missing.push(`${job}: ${permission} ${level}`);
    }
  }

  assert.deepEqual(missing, []);
});
