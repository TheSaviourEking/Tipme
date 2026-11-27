/**
 * The build's identity, inlined into the pages and served by /api/version, so an open page can
 * tell when the server has moved on to a newer build. The deploy passes the version it ships
 * (TIPME_BUILD_VERSION, or GIT_SHA as the API's image has): the image is built from a context with
 * no .git, and the deploy's check compares /api/version with that exact value. Outside a deploy,
 * the checkout's commit; failing that, the build time.
 */
export function buildVersion(
  env: Record<string, string | undefined>,
  gitHead: () => string,
): string {
  for (const name of ['TIPME_BUILD_VERSION', 'GIT_SHA']) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  try {
    const head = gitHead().trim();
    if (head) return head;
  } catch {
    // Not a git checkout.
  }
  return String(Date.now());
}
