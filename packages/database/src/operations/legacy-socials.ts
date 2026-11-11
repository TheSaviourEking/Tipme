import type { SocialLink, Socials } from '@tipme/contracts';

/** The first Facebook, Instagram and X links, in the old shape, for tabs opened before `links`. */
export function legacySocials(links: readonly SocialLink[]): Socials {
  const socials: Socials = {};
  for (const link of links)
    if (
      (link.platform === 'facebook' ||
        link.platform === 'instagram' ||
        link.platform === 'x') &&
      !socials[link.platform]
    )
      socials[link.platform] = link.url;
  return socials;
}
