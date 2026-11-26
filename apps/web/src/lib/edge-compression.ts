/**
 * Whether Next compresses its own answers. It does wherever it serves browsers directly (next start,
 * the e2e stack, review:screens). The self-hosted image runs behind the edge Caddy, which compresses
 * (zstd, gzip) without buffering a streamed page, so its build sets TIPME_EDGE_COMPRESSES=on
 * (deploy/web.Dockerfile) and Next leaves it to the edge. Read when next.config is evaluated, at
 * build: standalone keeps that build's config, so the running image has the same answer.
 */
export function nextCompresses(
  env: Record<string, string | undefined>,
): boolean {
  return env['TIPME_EDGE_COMPRESSES'] !== 'on';
}
