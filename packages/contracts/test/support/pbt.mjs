// Shared settings for the Page Studio property-based tests (fast-check).
// CI runs `fallback` cases per property (2,000 by default); locally 200, or STUDIO_PBT_RUNS.
// The seed comes from GITHUB_SHA, so a CI failure replays exactly on that commit; locally it
// is STUDIO_PBT_SEED or random. fast-check prints the seed and the shrunk counterexample on
// failure: add the counterexample to fixtures/studio-regressions.json and it replays every run.
import { readFileSync } from 'node:fs';

export function runs(fallback = 2000) {
  const set = Number(process.env.STUDIO_PBT_RUNS);
  if (Number.isInteger(set) && set > 0) return set;
  return process.env.CI ? fallback : 200;
}

export function seed() {
  const sha = process.env.GITHUB_SHA;
  if (sha && /^[0-9a-f]{8}/i.test(sha))
    return Number.parseInt(sha.slice(0, 8), 16) | 0;
  const set = Number(process.env.STUDIO_PBT_SEED);
  if (Number.isInteger(set)) return set;
  return (Math.random() * 2 ** 31) | 0;
}

const file = new URL('../fixtures/studio-regressions.json', import.meta.url);

/** Counterexamples recorded for one property, replayed before the random cases. */
export function regressions(property) {
  const all = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(all[property]) ? all[property] : [];
}
