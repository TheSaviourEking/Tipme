/**
 * The API as reached from the web server, which may differ from the browser's address: staging's
 * web reaches its API over the edge network (API_INTERNAL_ORIGIN). Compose passes a blank value
 * for an unused setting, so blank means unset here, never an empty origin.
 */
export function serverApiOrigin(
  env: Record<string, string | undefined>,
): string {
  for (const name of ['API_INTERNAL_ORIGIN', 'NEXT_PUBLIC_API_ORIGIN']) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return 'http://localhost:4000';
}
