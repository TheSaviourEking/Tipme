/**
 * The home page's schema.org graph: who TipMe is and what the site is. Kept free of imports so a
 * plain node test can load it; the page passes the origin and the descriptions in.
 *
 * Deliberately small and factual: no ratings, prices, reviews or licensing claims, and no
 * `sameAs` until the repo defines official TipMe profile URLs. Revisit when the giving product
 * launches.
 */
export type HomeStructuredDataInput = {
  /** The site origin, e.g. `siteOrigin.origin`. */
  origin: string;
  /** Root-relative path of a square logo that exists. */
  logoPath: string;
  siteDescription: string;
  homeDescription: string;
};

export function homeStructuredData({
  origin,
  logoPath,
  siteDescription,
  homeDescription,
}: HomeStructuredDataInput) {
  const url = new URL('/', origin).toString();
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        name: 'TipMe',
        url,
        logo: new URL(logoPath, origin).toString(),
        description: siteDescription,
      },
      {
        '@type': 'WebSite',
        name: 'TipMe',
        url,
        description: homeDescription,
      },
    ],
  };
}

/** JSON for a script tag: `<` becomes < so nothing can close the tag early. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
