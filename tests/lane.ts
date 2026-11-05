/**
 * E2E lanes: one number, E2E_LANE, picks every value that two concurrent browser-suite runs would
 * otherwise share (ports, database, Redis db and queue prefix). Lane 0 (or unset) is exactly the
 * original single-run stack, so CI is unchanged. tests/lane.mjs is the same function for scripts;
 * scripts/lane.test.mjs fails if the two disagree.
 */
export interface LaneConfig {
  lane: number;
  webPort: number;
  apiPort: number;
  webOrigin: string;
  apiOrigin: string;
  databaseName: string;
  redisDb: number | null;
  queuePrefix: string;
  outputDir: string;
}

export const MAX_LANE = 9;

export function laneConfig(
  value: string | number | undefined = process.env['E2E_LANE'],
): LaneConfig {
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

/** `url` with only its database name replaced. */
export function withDatabaseName(url: string, name: string): string {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
}

/** `url` pointed at a Redis logical db; lane 0 (null) keeps the URL as given. */
export function withRedisDb(url: string, db: number | null): string {
  if (db === null) return url;
  const next = new URL(url);
  next.pathname = `/${db}`;
  return next.toString();
}
