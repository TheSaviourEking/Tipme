// Where a page's picture comes from (PR-013): an uploaded photo is served by the API
// (/v1/avatars/...), the seeded demo portraits and illustrations by the web app. Anything else
// is ignored.
export const API_ORIGIN =
  process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';

export function avatarSource(
  path: string,
  name: string,
  apiOrigin: string,
): { src: string; alt: string } | null {
  if (/^\/v1\/avatars\/[0-9a-f-]+\/\d+\.webp$/.test(path))
    return { src: `${apiOrigin}${path}`, alt: `Photo of ${name}` };
  if (/^\/portraits\/[a-z0-9-]+\.webp$/.test(path))
    return {
      src: path,
      alt: `Portrait of ${name}, a fictional demo recipient`,
    };
  if (/^\/illustrations\/[a-z0-9-]+\.svg$/.test(path))
    return {
      src: path,
      alt: `Illustrated avatar of ${name}, a fictional demo recipient`,
    };
  return null;
}

/** Whether a page has a picture `Avatar` can show (otherwise show initials instead). */
export const hasAvatar = (path: string | null | undefined): path is string =>
  Boolean(path && avatarSource(path, '', API_ORIGIN));
