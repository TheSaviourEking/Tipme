import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildSlackPayload,
  getGitCommits,
  main,
  parseCommits,
} from './notify-slack.mjs';

test('parseCommits categorizes fixes, features, and chores', () => {
  const sampleLog = `
fefbdbe\tfix: update e2e test script to include database preparation step
f325119\tfix(tests): update Playwright configuration to use port directly
be5cc00\tfeat: add pro tipping support
4782fdb\tci: update CI workflow to include integration and e2e jobs
1f50b77\tdocs(agent): update staging deployment documentation
1234567\tRandom unformatted commit message
`;

  const parsed = parseCommits(sampleLog);
  assert.equal(parsed.all.length, 6);
  assert.equal(parsed.fixes.length, 2);
  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.chores.length, 2);
  assert.equal(parsed.other.length, 1);

  assert.equal(parsed.fixes[0].hash, 'fefbdbe');
  assert.equal(
    parsed.fixes[0].subject,
    'fix: update e2e test script to include database preparation step',
  );
  assert.equal(
    parsed.fixes[1].subject,
    'fix(tests): update Playwright configuration to use port directly',
  );
  assert.equal(parsed.features[0].subject, 'feat: add pro tipping support');
});

test('parseCommits handles empty or invalid input', () => {
  const parsedEmpty = parseCommits('');
  assert.equal(parsedEmpty.all.length, 0);
  assert.equal(parsedEmpty.fixes.length, 0);

  const parsedNull = parseCommits(null);
  assert.equal(parsedNull.all.length, 0);
});

test('buildSlackPayload builds valid Block Kit structure for success', () => {
  const commits = {
    all: [{ hash: '123', subject: 'fix: a bug' }],
    fixes: [
      { hash: '123', subject: 'fix: resolve race condition in payments' },
    ],
    features: [{ hash: '456', subject: 'feat: add instant receipt download' }],
    perf: [],
    chores: [],
    other: [],
  };

  const payload = buildSlackPayload({
    status: 'success',
    environment: 'staging',
    version: '0123456789abcdef',
    webUrl: 'https://staging.usetipme.xyz',
    apiUrl: 'https://api.staging.usetipme.xyz',
    repo: 'TheSaviourEking/Tipme',
    actor: 'dev-user',
    runUrl: 'https://github.com/TheSaviourEking/Tipme/actions/runs/12345',
    commits,
  });

  assert.ok(payload.blocks);
  assert.ok(payload.blocks.length >= 4);

  // Check header
  assert.equal(payload.blocks[0].type, 'header');
  assert.match(
    payload.blocks[0].text.text,
    /TipMe Staging Deployed Successfully/,
  );

  // Check fields
  const fieldsBlock = payload.blocks[1];
  assert.equal(fieldsBlock.type, 'section');
  const fieldTexts = fieldsBlock.fields.map((f) => f.text).join(' ');
  assert.match(fieldTexts, /Staging/);
  assert.match(fieldTexts, /01234567/);
  assert.match(fieldTexts, /@dev-user/);
  assert.match(fieldTexts, /staging\.usetipme\.xyz/);

  // Check fixes and features sections
  const textBlocks = payload.blocks
    .filter((b) => b.type === 'section' && b.text)
    .map((b) => b.text.text);

  assert.ok(
    textBlocks.some(
      (t) =>
        t.includes('Fixes & Bug Fixes') && t.includes('resolve race condition'),
    ),
  );
  assert.ok(
    textBlocks.some(
      (t) =>
        t.includes('Features & Product Updates') &&
        t.includes('instant receipt download'),
    ),
  );
});

test('buildSlackPayload builds valid warning payload for failure', () => {
  const payload = buildSlackPayload({
    status: 'failure',
    environment: 'staging',
    version: 'abcdef12',
    runUrl: 'https://github.com/TheSaviourEking/Tipme/actions/runs/999',
  });

  assert.ok(payload.blocks);
  assert.equal(payload.blocks[0].type, 'header');
  assert.match(payload.blocks[0].text.text, /Deployment Failed/);

  const failureSection = payload.blocks.find(
    (b) =>
      b.type === 'section' && b.text && b.text.text.includes('checks failed'),
  );
  assert.ok(failureSection);
  assert.match(
    failureSection.text.text,
    /https:\/\/github\.com\/TheSaviourEking\/Tipme\/actions\/runs\/999/,
  );
});

test('main exits cleanly when SLACK_WEBHOOK_URL is not set', async () => {
  let logOutput = '';
  const originalLog = console.log;
  console.log = (msg) => {
    logOutput += msg + '\n';
  };

  try {
    await main(['node', 'scripts/notify-slack.mjs'], { SLACK_WEBHOOK_URL: '' });
    assert.match(logOutput, /SLACK_WEBHOOK_URL is not configured/);
  } finally {
    console.log = originalLog;
  }
});

test('main outputs dry-run payload when --dry-run is supplied', async () => {
  let logOutput = '';
  const originalLog = console.log;
  console.log = (msg) => {
    logOutput += msg + '\n';
  };

  try {
    await main(
      ['node', 'scripts/notify-slack.mjs', '--dry-run', '--status', 'success'],
      {},
    );
    assert.match(logOutput, /Dry-run payload/);
    assert.match(logOutput, /TipMe Staging Deployed Successfully/);
  } finally {
    console.log = originalLog;
  }
});

test('getGitCommits lists only what is new since the deployed version, without merge commits', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'notify-slack-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'dev');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
  const commit = (subject) => {
    git('commit', '-q', '--allow-empty', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  commit('feat: already on staging');
  const deployed = commit('fix: also already on staging');
  git('checkout', '-q', '-b', 'topic');
  commit('docs: the new documents');
  git('checkout', '-q', 'dev');
  git('merge', '-q', '--no-ff', '-m', 'Merge pull request #13', 'topic');

  const commits = getGitCommits({ range: `${deployed}..HEAD`, cwd });
  assert.deepEqual(
    commits.all.map((c) => c.subject),
    ['docs: the new documents'],
  );
  assert.deepEqual(commits.fixes, []);
  assert.deepEqual(commits.features, []);
});
