/**
 * The cache tag for everything public about one business (`/b/<slug>/…`). The API's revalidate call
 * names the business after staff verify, suspend or restore it (PR B2); B4's reads of the public
 * business pages tag their fetches with this, so a suspension shows at once (M11).
 */
export const businessTag = (slug: string) => `business:${slug}`;
