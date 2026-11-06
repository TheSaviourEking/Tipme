#!/usr/bin/env node
// Tells TipMe which changelog entries a deployed version carries (changelog plan, Design §2).
//
//   node scripts/changelog-sync.mjs --environment production|staging --version <12 hex> [--api <url>]
//
// Run from a full-history checkout, after the deploy's release check has confirmed the environment
// serves <version>. It asks TipMe for the entries that environment has not run yet (numbers and
// merge commits only), keeps those whose merge commit is an ancestor of <version>
// (`git merge-base --is-ancestor`, never through a shell), and reports them as released. Entries
// still missing after 14 days, by their commit date in git, are listed: on production that
// usually means main stopped taking dev through a merge commit.
//
// Env: CHANGELOG_API_URL (unless --api), CHANGELOG_SIGNING_SECRET, GITHUB_STEP_SUMMARY (optional).
// Exits 0 with a notice when the changelog is not set up, 1 on any other failure. The deploy
// workflows run it with continue-on-error, so it can never make a deploy look failed.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { post, settingsFrom } from './changelog-client.mjs';

const STUCK_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const STUCK_HINT = {
  production: 'check that main still merges dev with a merge commit',
  staging: 'check that staging still deploys dev',
};
const WHERE = { production: 'now live', staging: 'now on staging' };

/** 'yes', 'no' or 'unknown' (the sha is not in this checkout, or git failed). */
export function contains(sha, version, cwd = process.cwd()) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, version], {
      cwd,
      stdio: 'ignore',
    });
    return 'yes';
  } catch (error) {
    return error.status === 1 ? 'no' : 'unknown';
  }
}

/** The commit date of `sha` in milliseconds, or null. */
function commitDate(sha, cwd) {
  try {
    const iso = execFileSync('git', ['show', '-s', '--format=%cI', sha], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const at = Date.parse(iso);
    return Number.isNaN(at) ? null : at;
  } catch {
    return null;
  }
}

function versionInCheckout(version, cwd) {
  try {
    execFileSync(
      'git',
      ['rev-parse', '--verify', '--quiet', `${version}^{commit}`],
      {
        cwd,
        stdio: 'ignore',
      },
    );
    return true;
  } catch {
    return false;
  }
}

const list = (numbers) => numbers.map((n) => `#${n}`).join(', ');
const entries = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;

function report(lines, env) {
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      environment: { type: 'string' },
      version: { type: 'string' },
      api: { type: 'string' },
    },
    strict: true,
  });
  if (values.environment !== 'production' && values.environment !== 'staging')
    throw new Error('--environment must be production or staging.');
  if (!/^[0-9a-f]{12}$/.test(values.version ?? ''))
    throw new Error(
      '--version must be the 12-character version the environment runs.',
    );
  return values;
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
) {
  let args;
  try {
    args = options(argv);
  } catch (error) {
    console.log(`::error::Changelog sync: ${error.message}`);
    return 1;
  }
  const { environment, version } = args;
  const settings = settingsFrom({
    ...env,
    CHANGELOG_API_URL: args.api ?? env.CHANGELOG_API_URL,
  });
  if (!settings.secret) {
    console.log(
      `::notice::Changelog not set up: ${settings.missing} is not set, so nothing was marked (docs/runbooks/changelog.md).`,
    );
    return 0;
  }
  if (!versionInCheckout(version, cwd)) {
    console.log(
      `::error::Changelog sync: ${version} is not a commit in this checkout (it needs full history).`,
    );
    return 1;
  }

  try {
    const answer = await post(
      settings.api,
      'pending',
      { environment },
      settings.secret,
    );
    const pending = Array.isArray(answer?.data) ? answer.data : [];
    const contained = [];
    const unknown = [];
    const stuck = [];
    const now = Date.now();
    for (const { number, mergeSha } of pending) {
      const found = /^[0-9a-f]{40}$/.test(mergeSha)
        ? contains(mergeSha, version, cwd)
        : 'unknown';
      if (found === 'yes') contained.push(number);
      else if (found === 'unknown') unknown.push(number);
      else {
        const at = commitDate(mergeSha, cwd);
        if (at !== null && now - at > STUCK_AFTER_MS) stuck.push(number);
      }
    }

    let marked = [];
    if (contained.length) {
      const released = await post(
        settings.api,
        'releases',
        { environment, version, contained },
        settings.secret,
      );
      marked = Array.isArray(released?.data?.marked)
        ? released.data.marked
        : [];
    }

    const lines = [
      marked.length
        ? `Changelog: ${entries(marked.length)} ${WHERE[environment]} (${list(marked)}).`
        : `Changelog: nothing new is ${environment === 'production' ? 'live' : 'on staging'} in this version (${version}).`,
    ];
    if (unknown.length) {
      lines.push(
        '',
        `Skipped, merge commit not in this checkout: ${list(unknown)}. Resend or withdraw them in admin if they were never merged into dev.`,
      );
    }
    if (stuck.length) {
      const message = `not in this version after 14 days: ${STUCK_HINT[environment]} (${list(stuck)})`;
      console.log(`::warning::Changelog: ${entries(stuck.length)} ${message}.`);
      lines.push('', `Pending ${message}.`);
    }
    report(lines, env);
    return 0;
  } catch (error) {
    console.log(
      `::error::Changelog sync for ${environment} failed: ${error.message}`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
