// What a production database connection must look like. A database on the same host or Docker
// network may connect without TLS; one across the network (a managed Postgres such as Aiven)
// must use TLS and check the server's certificate, or its traffic and passwords can be
// intercepted. node-postgres reads `sslmode` and `sslrootcert` (a CA file) from the URL.

const LOCAL_HOSTS = new Set([
  'postgres',
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);
const CHECKED = new Set(['verify-full', 'verify-ca']);

/** Why this URL is not safe for production, or null when it is. */
export function productionDatabaseUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'is not a URL';
  }
  if (LOCAL_HOSTS.has(parsed.hostname)) return null;
  const mode = parsed.searchParams.get('sslmode');
  if (!mode || !CHECKED.has(mode))
    return 'a database across the network needs sslmode=verify-full (with sslrootcert= its CA file) in production';
  return null;
}
