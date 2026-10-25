#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import process from 'node:process';

/**
 * Parses raw git log output into structured commit entries and categorized lists.
 * Format expected: "%h\t%s" (short hash, tab, subject line).
 */
export function parseCommits(rawLog) {
  if (!rawLog || typeof rawLog !== 'string') {
    return {
      all: [],
      fixes: [],
      features: [],
      perf: [],
      chores: [],
      other: [],
    };
  }

  const lines = rawLog
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const entries = [];
  const fixes = [];
  const features = [];
  const perf = [];
  const chores = [];
  const other = [];

  for (const line of lines) {
    const tabIdx = line.indexOf('\t');
    const hash = tabIdx !== -1 ? line.slice(0, tabIdx) : '';
    const subject = tabIdx !== -1 ? line.slice(tabIdx + 1).trim() : line;

    if (!subject) continue;

    const entry = { hash, subject };
    entries.push(entry);

    if (/^fix(\([^)]+\))?:/i.test(subject)) {
      fixes.push(entry);
    } else if (/^feat(\([^)]+\))?:/i.test(subject)) {
      features.push(entry);
    } else if (/^perf(\([^)]+\))?:/i.test(subject)) {
      perf.push(entry);
    } else if (/^(chore|docs|ci|test|refactor)(\([^)]+\))?:/i.test(subject)) {
      chores.push(entry);
    } else {
      other.push(entry);
    }
  }

  return { all: entries, fixes, features, perf, chores, other };
}

/**
 * Reads git log for the requested range or limit.
 */
export function getGitCommits({ range, limit = 10, cwd = process.cwd() } = {}) {
  try {
    // Merge commits only repeat their pull request's own commits.
    const args = ['log', '--no-merges', '--format=%h\t%s'];
    if (range) {
      args.push(range);
    } else {
      args.push(`-n${Number(limit) || 10}`);
    }
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseCommits(stdout);
  } catch {
    return {
      all: [],
      fixes: [],
      features: [],
      perf: [],
      chores: [],
      other: [],
    };
  }
}

/**
 * Builds a Slack Block Kit payload for deployment notifications and fix summaries.
 */
/**
 * How the person who deployed appears in Slack. `usersJson` (the SLACK_USERS variable) maps a
 * GitHub login to a Slack member ID (a real mention, e.g. "U012AB3CD") or a display name.
 */
export function slackMention(actor, usersJson = '') {
  let users = {};
  try {
    users = JSON.parse(usersJson || '{}') ?? {};
  } catch {
    users = {};
  }
  const mapped = typeof users[actor] === 'string' ? users[actor].trim() : '';
  if (/^[UW][A-Z0-9]{6,}$/.test(mapped)) return `<@${mapped}>`;
  const name = (mapped || actor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `@${name}`;
}

export function buildSlackPayload({
  status = 'success',
  environment = 'staging',
  version = '',
  webUrl = '',
  apiUrl = '',
  repo = '',
  actor = '',
  slackUsers = '',
  runUrl = '',
  commits = {
    all: [],
    fixes: [],
    features: [],
    perf: [],
    chores: [],
    other: [],
  },
} = {}) {
  const isSuccess = status.toLowerCase() === 'success';
  const isFailure = status.toLowerCase() === 'failure';
  const envName = environment.charAt(0).toUpperCase() + environment.slice(1);

  const icon = isSuccess ? '🚀' : isFailure ? '❌' : '⚠️';
  const titleStatus = isSuccess
    ? 'Deployed Successfully'
    : isFailure
      ? 'Deployment Failed'
      : `Deployment ${status}`;
  const headerText = `${icon} TipMe ${envName} ${titleStatus}`;

  const shortVersion = version
    ? version.length > 8
      ? version.slice(0, 8)
      : version
    : 'latest';
  const versionText =
    repo && version
      ? `<https://github.com/${repo}/commit/${version}|\`${shortVersion}\`>`
      : `\`${shortVersion}\``;

  const links = [];
  if (webUrl) links.push(`<${webUrl}|Web App>`);
  if (apiUrl) links.push(`<${apiUrl}|API>`);
  if (runUrl) links.push(`<${runUrl}|GitHub Run>`);

  const fields = [
    { type: 'mrkdwn', text: `*Environment:*\n${envName}` },
    { type: 'mrkdwn', text: `*Version:*\n${versionText}` },
  ];

  if (actor) {
    fields.push({
      type: 'mrkdwn',
      text: `*Triggered by:*\n${slackMention(actor, slackUsers)}`,
    });
  }
  if (links.length > 0) {
    fields.push({
      type: 'mrkdwn',
      text: `*Quick Links:*\n${links.join(' • ')}`,
    });
  }

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: headerText.slice(0, 150),
        emoji: true,
      },
    },
    {
      type: 'section',
      fields,
    },
  ];

  if (isSuccess) {
    // 1. Fixes section
    if (commits.fixes.length > 0) {
      blocks.push({ type: 'divider' });
      const fixLines = commits.fixes
        .slice(0, 8)
        .map((c) => `• ${c.subject}`)
        .join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*🛠️ Fixes & Bug Fixes (${commits.fixes.length}):*\n${fixLines}`,
        },
      });
    }

    // 2. Features section
    if (commits.features.length > 0) {
      if (commits.fixes.length === 0) blocks.push({ type: 'divider' });
      const featLines = commits.features
        .slice(0, 8)
        .map((c) => `• ${c.subject}`)
        .join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*✨ Features & Product Updates (${commits.features.length}):*\n${featLines}`,
        },
      });
    }

    // 3. Performance or other highlights if no fixes/features
    if (
      commits.fixes.length === 0 &&
      commits.features.length === 0 &&
      commits.all.length > 0
    ) {
      blocks.push({ type: 'divider' });
      const recentLines = commits.all
        .slice(0, 5)
        .map((c) => `• ${c.subject}`)
        .join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*📦 Recent Changes (${commits.all.length}):*\n${recentLines}`,
        },
      });
    }
  } else if (isFailure) {
    blocks.push({ type: 'divider' });
    const runLink = runUrl
      ? `<${runUrl}|GitHub Actions workflow run>`
      : 'GitHub Actions';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⚠️ *Deployment or release verification checks failed.* Please inspect the ${runLink} for logs and error traces.`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `TipMe Delivery • ${new Date().toUTCString()}`,
      },
    ],
  });

  return { blocks };
}

/**
 * Parses CLI arguments.
 */
function parseArgs(argv) {
  const options = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'dry-run') {
        options.dryRun = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        options[key] = argv[++i];
      }
    }
  }
  return options;
}

export async function main(argv = process.argv, env = process.env) {
  const args = parseArgs(argv);
  const webhookUrl = args['webhook-url'] || env.SLACK_WEBHOOK_URL;
  const dryRun = args.dryRun || false;

  const status = args.status || 'success';
  const environment = args.environment || 'staging';
  const version = args.version || env.VERSION || '';
  const webUrl = args['web-url'] || env.STAGING_WEB_URL || '';
  const apiUrl = args['api-url'] || env.STAGING_API_URL || '';
  const repo = args.repo || env.GITHUB_REPOSITORY || '';
  const actor = args.actor || env.GITHUB_ACTOR || '';
  const runUrl =
    args['run-url'] ||
    (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : '');

  const commits = getGitCommits({
    range: args['commit-range'],
    limit: args.limit || 10,
  });

  const payload = buildSlackPayload({
    status,
    environment,
    version,
    webUrl,
    apiUrl,
    repo,
    actor,
    slackUsers: env.SLACK_USERS || '',
    runUrl,
    commits,
  });

  if (dryRun) {
    console.log('[notify-slack] Dry-run payload:');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!webhookUrl) {
    console.log(
      '[notify-slack] SLACK_WEBHOOK_URL is not configured; skipping Slack notification.',
    );
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(
        `[notify-slack] Failed to deliver Slack notification (HTTP ${response.status}): ${text}`,
      );
      // Do not throw or fail the deploy workflow just because Slack had a transient failure
      return;
    }

    console.log(
      `[notify-slack] Successfully posted ${environment} deployment notification to Slack.`,
    );
  } catch (err) {
    console.error(
      `[notify-slack] Error sending Slack notification: ${err.message}`,
    );
  }
}

// Execute when invoked as entry script
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[notify-slack] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
