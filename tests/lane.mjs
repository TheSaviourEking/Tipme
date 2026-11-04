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
