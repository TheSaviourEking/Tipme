import { parse } from 'pg-connection-string';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Migrations and seeds may only touch a local database (AGENTS.md). Checks the host the `pg`
 * driver will actually use: `?host=` and `?hostaddr=` override the URL's hostname, and socket
 * paths (e.g. Cloud SQL proxies) are not considered local. Names the host, never credentials.
 */
export function assertLocalDatabaseUrl(url: string): void {
  let host: string | undefined;
  let hostaddr: string | undefined;
  try {
    const parsed = parse(url);
    host = parsed.host ?? undefined;
    hostaddr = (parsed as { hostaddr?: string }).hostaddr;
  } catch {
    throw new Error('Refusing to use a database URL that cannot be parsed');
  }
  // The host must be local; a hostaddr, if given, must be local too.
  const targets = hostaddr === undefined ? [host] : [host, hostaddr];
  for (const target of targets) {
    if (!target || !LOCAL_HOSTS.has(target)) {
      throw new Error(
        `Refusing to use a non-local database: ${target ?? '(none)'}`,
      );
    }
  }
}
