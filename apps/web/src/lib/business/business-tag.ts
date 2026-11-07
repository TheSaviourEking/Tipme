/**
 * The cache tag for everything public about one business (`/b/<slug>/…`). The API's revalidate call
 * names the business after staff verify, suspend or restore it (PR B2); B4's reads of the public
 * business pages tag their fetches with this, so a suspension shows at once (M11). Lower-cased, as slugs are, so a page reached by a
 * mixed-case address shares the tag the API names.
 */
export const businessTag = (slug: string) => `business:${slug.toLowerCase()}`;
