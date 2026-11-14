/**
 * Where to go after signing in: only a dashboard (or admin) path on this site, or the /pro page
 * (a signed-out person who pressed Get Pro comes back to buy), resolved the way the browser
 * would (so "/\evil.com" or "//evil.com" can never leave it). Anything else goes to the dashboard.
 */
export function safeNext(value: string | null, origin: string): string {
  if (!value || !value.startsWith('/')) return '/dashboard';
  try {
    const url = new URL(value, origin);
    if (url.origin !== new URL(origin).origin) return '/dashboard';
    // Signing in only ever leads back into the dashboard, or the admin area for staff.
    const within = (root: string) =>
      url.pathname === root || url.pathname.startsWith(`${root}/`);
    if (url.pathname === '/pro') return '/pro';
    if (!within('/dashboard') && !within('/ops')) return '/dashboard';
    return `${url.pathname}${url.search}`;
  } catch {
    return '/dashboard';
  }
}
