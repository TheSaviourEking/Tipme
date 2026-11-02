import { spawnSync } from 'node:child_process';

/*
 * The browser suite in two stages. Playwright shards only top-level projects, so a project that
 * depends on the others makes every shard run them all; and @alone tests remove other staff, so
 * nothing may run beside them. So they are a separate run, chosen in playwright.config.ts.
 *
 *   test:e2e              everything: the suite, then @alone (even if the suite failed)
 *   test:e2e --shard=1/3  one share of the suite, no @alone (CI runs those as their own job)
 *   test:e2e --alone      only @alone
 *
 * Other arguments go to Playwright. A filter may match nothing in one stage, which isn't a failure.
 */
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const onlyAlone = args.includes('--alone');
const others = args.filter((arg) => arg !== '--alone');
const sharded = others.some((arg) => arg.startsWith('--shard'));

function stage(env, extra = []) {
  const { status, signal } = spawnSync(
    'playwright',
    ['test', ...extra, ...others],
    { stdio: 'inherit', env: { ...process.env, ...env } },
  );
  if (signal) process.kill(process.pid, signal);
  return status ?? 1;
}

const alone = { E2E_ALONE: '1' };
const filtered = ['--pass-with-no-tests'];
if (onlyAlone) process.exit(stage(alone));
if (sharded) process.exit(stage({}));
const suite = stage({}, filtered);
const lone = stage(alone, filtered);
process.exit(suite || lone);
