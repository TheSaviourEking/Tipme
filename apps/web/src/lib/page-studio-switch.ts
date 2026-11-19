/**
 * Whether Page Studio is switched on (the `page_studio` switch), from the API's public
 * /health/release. Anything unreadable is off, so a Studio route answers 404 rather than open.
 */
export function pageStudioOn(release: unknown): boolean {
  return (
    typeof release === 'object' &&
    release !== null &&
    (release as { pageStudio?: unknown }).pageStudio === true
  );
}
