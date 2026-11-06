import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Changelog plan, Task 3.3. The workflows are read as text (no YAML dependency): steps are the
// `      - ` items of a job's `steps:` list, as every workflow here is indented.
const WORKFLOWS = '.github/workflows';
const read = (name) => readFileSync(`${WORKFLOWS}/${name}`, 'utf8');

/** Each step of a workflow: its name, `if:`, `continue-on-error:`, env lines and run text. */
function steps(source) {
  const lines = source.split('\n');
  const found = [];
  let step = null;
  let block = null;
  for (const line of lines) {
    const start = line.match(/^ {6}- (.*)$/);
    if (start) {
      step = { lines: [], run: '', env: [] };
      found.push(step);
      block = null;
    } else if (step && line.trim() && !/^ {8}/.test(line)) {
      step = null;
      block = null;
    }
    if (!step) continue;
    const body = start ? `        ${start[1]}` : line;
    step.lines.push(body);
    const key = body.match(/^ {8}([a-z-]+):\s?(.*)$/);
    if (key) {
      block = key[1];
      if (key[1] === 'name') step.name = key[2].replace(/^'(.*)'$/, '$1');
      if (key[1] === 'if') step.if = key[2];
      if (key[1] === 'continue-on-error') step.continueOnError = key[2];
      if (key[1] === 'run') step.run += key[2] === '|' ? '' : `${key[2]}\n`;
      continue;
    }
    if (block === 'run' && body.trim()) step.run += `${body.trim()}\n`;
    if (block === 'env' && body.trim()) step.env.push(body.trim());
  }
  return found;
}

const named = (source, name) => {
  const all = steps(source);
  const index = all.findIndex((s) => s.name === name);
  assert.ok(index >= 0, `no step named ${name}`);
  return { step: all[index], index, all };
};

test('no run block in any workflow interpolates a pull request title, body or branch', () => {
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    for (const step of steps(read(file))) {
      assert.doesNotMatch(
        step.run,
        /github\.event\.pull_request\.(title|body|head\.ref)|\.title\b.*\}\}|\.body\b.*\}\}/,
        `${file}: ${step.name ?? '(unnamed step)'} interpolates PR text`,
      );
    }
  }
});

test('the changelog workflows put nothing from ${{ }} into a shell line', () => {
  for (const file of ['changelog-draft.yml', 'changelog-sync.yml']) {
    for (const step of steps(read(file))) {
      assert.doesNotMatch(step.run, /\$\{\{/, `${file}: ${step.name}`);
    }
  }
});

test('the signing secret is only ever passed as a GitHub secret through env, never echoed', () => {
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const source = read(file);
    for (const step of steps(source)) {
      assert.doesNotMatch(
        step.run,
        /CHANGELOG_SIGNING_SECRET/,
        `${file}: ${step.name}`,
      );
      for (const line of step.env.filter((l) =>
        l.startsWith('CHANGELOG_SIGNING_SECRET:'),
      ))
        assert.equal(
          line,
          'CHANGELOG_SIGNING_SECRET: ${{ secrets.CHANGELOG_SIGNING_SECRET }}',
          file,
        );
    }
    // Nowhere else, and never a value.
    for (const line of source
      .split('\n')
      .filter((l) => l.includes('CHANGELOG_SIGNING_SECRET')))
      assert.ok(
        line.trim().startsWith('#') ||
          line.trim() ===
            'CHANGELOG_SIGNING_SECRET: ${{ secrets.CHANGELOG_SIGNING_SECRET }}',
        `${file}: ${line.trim()}`,
      );
  }
});

test('the production sync runs after the release check, only on success, and can never fail the deploy', () => {
  const source = read('deploy-production.yml');
  const check = named(source, 'Release check (read-only)');
  const sync = named(source, 'Changelog: what is now live');
  assert.equal(sync.index, check.index + 1);
  assert.equal(sync.step.continueOnError, 'true');
  assert.equal(sync.step.if, 'success()');
  assert.match(
    sync.step.run,
    /^node scripts\/changelog-sync\.mjs --environment production --version "\$VERSION"\n$/,
  );
  assert.ok(
    sync.step.env.includes('CHANGELOG_API_URL: ${{ vars.CHANGELOG_API_URL }}'),
  );
  assert.ok(sync.step.lines.some((l) => /timeout-minutes: \d+$/.test(l)));
  // The deploy job keeps the full history the ancestry check needs.
  assert.match(source, /fetch-depth: 0/);
  // The header lists the new secret and variable.
  assert.match(
    source.split('name: Deploy production')[0],
    /CHANGELOG_SIGNING_SECRET/,
  );
  assert.match(source.split('name: Deploy production')[0], /CHANGELOG_API_URL/);
});

test('the staging sync runs after the release check and before the staging pass is recorded', () => {
  const source = read('deploy-staging.yml');
  const check = named(source, 'Release check');
  const sync = named(source, 'Changelog: what is now on staging');
  const record = named(source, 'Record the full staging pass');
  assert.ok(check.index < sync.index && sync.index < record.index);
  assert.equal(sync.index, check.index + 1);
  assert.equal(record.index, sync.index + 1);
  assert.equal(sync.step.continueOnError, 'true');
  assert.equal(sync.step.if, 'success()');
  assert.match(
    sync.step.run,
    /^node scripts\/changelog-sync\.mjs --environment staging --version "\$VERSION"\n$/,
  );
  // Drafts and "on staging" both live in production's database (Open Q3).
  assert.ok(
    sync.step.env.includes('CHANGELOG_API_URL: ${{ vars.CHANGELOG_API_URL }}'),
  );
  // The record still reads the release check's own outcome.
  assert.equal(
    record.step.if,
    "success() && steps.release.outputs.full == 'true'",
  );
  assert.match(
    source.split('name: Deploy staging')[0],
    /CHANGELOG_SIGNING_SECRET/,
  );
});

test('the draft workflow runs on merged pull requests into dev, read-only, without pull_request_target', () => {
  const source = read('changelog-draft.yml');
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(code, /pull_request_target/);
  assert.match(
    source,
    /^on:\n {2}pull_request:\n {4}types: \[closed\]\n {4}branches: \[dev\]\n/m,
  );
  assert.match(source, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}number:/m);
  assert.match(source, /^permissions:\n {2}contents: read\n/m);
  assert.match(
    source,
    /github\.event_name == 'workflow_dispatch' \|\|\s+\(github\.event\.pull_request\.merged == true &&\s+github\.event\.pull_request\.base\.ref == 'dev'\)/,
  );
  assert.match(source, /persist-credentials: false/);
  assert.match(
    source,
    /ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha \|\| github\.sha \}\}/,
  );
  const send = named(source, 'Send the draft');
  assert.equal(send.step.run, 'node scripts/changelog-send.mjs\n');
  // The PR comes from the event's file, never env: Linux caps one variable at 128 KiB.
  assert.ok(
    send.step.env.includes('CHANGELOG_EVENT_FILE: ${{ github.event_path }}'),
  );
  assert.ok(!send.step.env.some((line) => /PR_BODY|PR_TITLE/.test(line)));
  // No dependency install: the scripts use Node only.
  assert.doesNotMatch(source, /pnpm install/);
});

test('the catch-up sync reads the running version and checks out full history', () => {
  const source = read('changelog-sync.yml');
  assert.match(
    source,
    /^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}environment:/m,
  );
  assert.match(source, /options: \[production, staging\]/);
  assert.match(source, /fetch-depth: 0/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /\/health\/release/);
  assert.match(source, /vars\.PRODUCTION_API_URL/);
  assert.match(source, /vars\.STAGING_API_URL/);
  const sync = named(source, 'Sync');
  assert.match(
    sync.step.run,
    /node scripts\/changelog-sync\.mjs --environment "\$ENVIRONMENT" --version "\$VERSION"/,
  );
});

test('the PR template has a For users section with the hint, which on its own drafts nothing for users', () => {
  const template = readFileSync('.github/PULL_REQUEST_TEMPLATE.md', 'utf8');
  assert.match(
    template,
    /^## For users\n<!-- One or two sentences a recipient would notice, in plain words\. Leave empty if they won't notice anything\. Never name our payment partner; never say TipMe is licensed or approved\. -->\n/m,
  );
  // Before any long section, so cutting a long body to the size limit keeps it.
  assert.ok(template.indexOf('## For users') < template.indexOf('## Evidence'));
});
