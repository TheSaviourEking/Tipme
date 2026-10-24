// Where a page's picture comes from (PR-013): an uploaded photo is served by the API
// (/v1/avatars/...), the seeded demo illustrations by the web app. Anything else is ignored.
export function avatarSource(
  path: string,
  name: string,
  apiOrigin: string,
): { src: string; alt: string } | null {
  if (/^\/v1\/avatars\/[0-9a-f-]+\/\d+\.webp$/.test(path))
    return { src: `${apiOrigin}${path}`, alt: `Photo of ${name}` };
  if (/^\/illustrations\/[a-z0-9-]+\.svg$/.test(path))
    return {
      src: path,
      alt: `Illustrated avatar of ${name}, a fictional demo recipient`,
    };
  return null;
}
