// Campaign Studio: a campaign link is `/@handle/<ending>` (rewritten to /people/handle/<ending>).
// It opens the normal tip page; the ending is read from the address only, never shown on it.

const ENDING = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
// Paths under /people/handle/ that are pages of their own, not campaigns.
const NOT_CAMPAIGNS = new Set(['share-card']);

/** The campaign ending of a tip page's address, or undefined for the plain link. */
export function campaignFromPath(pathname: string): string | undefined {
  const match = /^\/(?:@|people\/)[^/]+\/([^/]+)\/?$/.exec(pathname);
  const ending = match?.[1];
  return ending && ENDING.test(ending) && !NOT_CAMPAIGNS.has(ending)
    ? ending
    : undefined;
}

/** The address to share, the one its QR code holds (tagged so scans count), and its label. */
export function campaignLink(origin: string, handle: string, slug: string) {
  const url = `${origin}/@${handle}/${slug}`;
  return {
    url,
    qr: `${url}?src=qr`,
    label: url.replace(/^https?:\/\//, ''),
  };
}

/** A link ending made from a name: "Saturday gig!" → "saturday-gig". */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
}
