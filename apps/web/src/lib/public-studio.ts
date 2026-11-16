import type {
  PublicProfile,
  PublicStudio,
  StudioDocument,
} from '@tipme/contracts';

/** A Studio photo as the API serves it: /v1/studio-images/<page>/<image>/<version>. */
const API_IMAGE = /^\/v1\/studio-images\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/\d+$/;
/** The Studio lab's generated test images (test builds only). */
const LAB_IMAGE = /^\/dev\/studio-lab\/image\/[0-9a-f-]{36}$/;

/**
 * The published Page Studio design this public page shows, or null for the standard page (plan
 * Task 8). The API sends `studio` only while the `page_studio` switch is on, for a live Pro page
 * whose published version passes today's design check; this repeats the Pro check, so a stale
 * answer can never dress a Free page. Campaign links (/@username/<ending>) keep the standard page:
 * the plan does not put Studio there. Photo addresses become the API's; anything else is dropped.
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
  if (!studio || campaign || profile.plan !== 'pro') return null;
  const images: PublicStudio['images'] = {};
  for (const [id, image] of Object.entries(studio.images)) {
    if (API_IMAGE.test(image.path))
      images[id] = { ...image, path: `${apiOrigin}${image.path}` };
    else if (labImages && LAB_IMAGE.test(image.path)) images[id] = image;
  }
  return { ...studio, images };
}

/**
 * TipMe's identity block beside a Studio design: name, photo, @username, role and Pro badge stay.
 * The bio and the links leave it only when the design has an About or Links block showing them,
 * so they never appear twice and nothing the person shared disappears.
 */
export function identityFor(
  profile: PublicProfile,
  doc: StudioDocument,
): PublicProfile {
  const kinds = new Set(
    doc.rows.flatMap((row) => row.cells.flat().map((block) => block.kind)),
  );
  const shown: PublicProfile = { ...profile };
  delete shown.studio;
  if (kinds.has('about')) delete shown.bio;
  if (kinds.has('links')) {
    delete shown.links;
    delete shown.socials;
  }
  return shown;
}
