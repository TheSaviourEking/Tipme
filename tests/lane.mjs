// E2E lanes for scripts: the same function as tests/lane.ts (scripts/lane.test.mjs keeps them equal).
export const MAX_LANE = 9;

export function laneConfig(value = process.env.E2E_LANE) {
  const text = String(value ?? '').trim();
  const lane = text === '' ? 0 : Number(text);
  if (!Number.isInteger(lane) || lane < 0 || lane > MAX_LANE)
    throw new Error(`E2E_LANE must be a whole number from 0 to ${MAX_LANE}.`);
  const webPort = 3100 + 10 * lane;
  const apiPort = 4100 + 10 * lane;
  return {
    lane,
    webPort,
    apiPort,
    webOrigin: `http://127.0.0.1:${webPort}`,
    apiOrigin: `http://127.0.0.1:${apiPort}`,
    databaseName: lane === 0 ? 'tipme_test' : `tipme_test_lane${lane}`,
    redisDb: lane === 0 ? null : 1 + lane,
    queuePrefix: lane === 0 ? 'e2e' : `e2e-lane${lane}`,
    outputDir: lane === 0 ? 'test-results' : `test-results/lane${lane}`,
  };
}

/** Where a build records which lane's API origin it baked in. */
export const LANE_STAMP = 'apps/web/.next/lane.json';

/** Written after a successful build, so a reused build can be checked against the current lane. */
export function writeLaneStamp(write, config = laneConfig()) {
  write(
    LANE_STAMP,
    JSON.stringify({ lane: config.lane, apiOrigin: config.apiOrigin }),
  );
}

/**
 * Refuses a reused build made for another lane (it would call that lane's API port). `read` returns
 * the stamp's text or undefined when there is none.
 */
export function assertBuildMatchesLane(read, config = laneConfig()) {
  const text = read(LANE_STAMP);
  if (text === undefined)
    throw new Error(
      `apps/web/.next has no lane stamp (${LANE_STAMP}), so its lane is unknown; E2E_LANE is ${config.lane}. Rebuild (drop --no-build).`,
    );
  let built;
  try {
    built = JSON.parse(text);
  } catch {
    built = {};
  }
  if (built.lane !== config.lane || built.apiOrigin !== config.apiOrigin)
    throw new Error(
      `apps/web/.next was built for lane ${built.lane ?? 'unknown'}; E2E_LANE is ${config.lane}. Rebuild (drop --no-build).`,
    );
}
