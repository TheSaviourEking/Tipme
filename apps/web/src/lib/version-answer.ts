/**
 * The production deploy writes this file in the old colour's website (its /tmp is a tmpfs) a few
 * seconds before it stops it (deploy/scripts/lib.sh, drain_web). /api/version then answers 503, so
 * the edge's health check moves page traffic to the new colour, while the old copy keeps serving the
 * assets of the pages it already sent.
 */
export const DRAIN_FILE = '/tmp/tipme-draining';

/** What /api/version answers: the build's version, 503 while draining; never cached. */
export function versionAnswer(
  version: string,
  draining: boolean,
): {
  status: number;
  body: { version: string; draining?: true };
  headers: Record<string, string>;
} {
  return {
    status: draining ? 503 : 200,
    body: draining ? { version, draining: true } : { version },
    headers: { 'Cache-Control': 'no-store' },
  };
}
