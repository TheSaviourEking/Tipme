/**
 * Whether an address is a public profile: /@username, /@username/<ending>, or the /people/ route
 * behind them. The site header's links don't prefetch there (components/nav-link.tsx).
 */
export const onProfilePage = (pathname: string): boolean =>
  /^\/(@|people\/)/.test(pathname);
