/**
 * The version of the build that is running, so an open page can tell whether TipMe was updated
 * since it loaded. Same build-time value the page carries (see next.config.ts); never cached.
 */
export function GET(): Response {
  return Response.json(
    { version: process.env.TIPME_BUILD_VERSION ?? '' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
