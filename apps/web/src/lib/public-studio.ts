import {
  studioImageIdsOf,
  studioShown,
  studioTokens,
  type PublicProfile,
  type PublicStudio,
} from '@tipme/contracts';

/** A Studio photo as the API serves it: /v1/studio-images/<page>/<image>/<version>. */
const API_IMAGE = /^\/v1\/studio-images\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/\d+$/;
/** The Studio lab's generated test images (test builds only). */
const LAB_IMAGE = /^\/dev\/studio-lab\/image\/[0-9a-f-]{36}$/;

/**
 * The published Page Studio design this public page shows, or null for today's standard page
 * (styles spec §11, §13). The API sends `studio` only while the `page_studio` switch is on, already
 * as the page's plan shows it; this applies the same `studioShown` to the plan the API sent, so a
 * stale answer can never put a Pro design on a Free page, and Classic with every default is the
 * standard page. Only a v2 design is shown: an older API's v1 design means the standard page.
 * Campaign links (/@username/<ending>) keep the standard page. Photo addresses become the API's;
 * anything else is dropped, as is any photo the shown design doesn't use.
 */
export function studioFor(
  profile: PublicProfile,
  {
    apiOrigin,
    labImages,
    campaign,
  }: { apiOrigin: string; labImages: boolean; campaign?: string },
): PublicStudio | null {
  const studio = profile.studio;
  if (!studio || campaign) return null;
  if ((studio.document as { v?: unknown }).v !== 2) return null;
  const shown = studioShown(
    studio.document,
    profile.plan === 'pro' ? 'pro' : 'free',
  );
  if (!shown) return null;
  const used = studioImageIdsOf(shown);
  const images: PublicStudio['images'] = {};
  for (const [id, image] of Object.entries(studio.images)) {
    if (!used.has(id)) continue;
    if (API_IMAGE.test(image.path))
      images[id] = { ...image, path: `${apiOrigin}${image.path}` };
    else if (labImages && LAB_IMAGE.test(image.path)) images[id] = image;
  }
  return {
    ...studio,
    document: shown,
    // The API's palette is for the document it sent; a design trimmed here gets its own.
    palette:
      shown === studio.document
        ? studio.palette
        : studioTokens(shown.style, shown.accent),
    images,
  };
}
