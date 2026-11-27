import { existsSync } from 'node:fs';
import { connection } from 'next/server';
import { DRAIN_FILE, versionAnswer } from '@/lib/version-answer';

/**
 * The version of the build that is running, so an open page can tell whether TipMe was updated
 * since it loaded. Same build-time value the page carries (see next.config.ts); never cached. Also
 * the edge's health check and the deploy's version check: a draining copy answers 503.
 */
export async function GET(): Promise<Response> {
  await connection();
  const { status, body, headers } = versionAnswer(
    process.env.TIPME_BUILD_VERSION ?? '',
    existsSync(DRAIN_FILE),
  );
  return Response.json(body, { status, headers });
}
