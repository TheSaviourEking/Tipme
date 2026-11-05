import { z } from 'zod';

// Social links on a page (SocialLinks board, approved by the owner 5 Nov 2026). Each site lists the
// https hosts its own help pages or share sheets use; sources are in the build report and
// docs/00-DECISIONS.md. Free pages show up to 3 links from Free sites in catalogue order; Pro pages
// show up to 8 from any site, in their own order, with one featured. OnlyFans and Fansly are Pro
// only by the owner's product decision (not a legal or regulatory approval).

export type SocialTier = 'free' | 'pro';

interface PlatformSpec {
  label: string;
  /** Letters drawn in the badge; brand logos are a later, brand-rules job. */
  badge: string;
  /** A light badge, for sites that are not one brand (a website) or are marked 18+. */
  light?: true;
  tier: SocialTier;
  hosts: readonly string[];
  /** Any subdomain of these is the site too (a Substack publication). */
  subdomainsOf?: readonly string[];
  /** What the path must look like (default: anything but the bare site). */
  path?: RegExp;
  /** The site's own redirect pages, which can send a visitor anywhere: refused as link pages. */
  redirect?: RegExp;
  /** Reads the handle shown on the page from the path: group 1, shown after `prefix`. */
  handle?: RegExp;
  prefix?: string;
  /** The words on the featured key (Pro). Fixed per site: no free text to moderate. */
  featured: string;
}

const at = (pattern: string) => new RegExp(`^/${pattern}/?$`);
const plainName = at('([A-Za-z0-9._-]{1,60})');

export const SOCIAL_PLATFORMS = {
  // ---- Free ----
  tiktok: {
    label: 'TikTok',
    badge: 'TT',
    tier: 'free',
    hosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'],
    handle: /^\/@([A-Za-z0-9._]{1,60})(?:\/|$)/,
    featured: 'Watch me on TikTok',
  },
  facebook: {
    label: 'Facebook',
    badge: 'f',
    tier: 'free',
    // web.facebook.com is where Facebook sends many visitors in Nigeria; m. is its mobile site.
    hosts: [
      'facebook.com',
      'www.facebook.com',
      'm.facebook.com',
      'web.facebook.com',
    ],
    redirect: /^\/(?:l\.php|flx\/)/,
    handle:
      /^\/(?!profile\.php|people\/|pages\/|groups\/|share\/|watch|events\/)([A-Za-z0-9.]{1,60})\/?$/,
    featured: 'Follow me on Facebook',
  },
  instagram: {
    label: 'Instagram',
    badge: 'IG',
    tier: 'free',
    hosts: ['instagram.com', 'www.instagram.com'],
    handle:
      /^\/(?!p\/|reel\/|reels\/|stories\/|explore\/)([A-Za-z0-9._]{1,30})\/?$/,
    featured: 'Follow me on Instagram',
  },
  youtube: {
    label: 'YouTube',
    badge: 'YT',
    tier: 'free',
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com'],
    redirect: /^\/redirect(?:\/|$)/,
    handle: /^\/@([A-Za-z0-9._-]{1,60})(?:\/|$)/,
    featured: 'Watch me on YouTube',
  },
  x: {
    label: 'X',
    badge: 'X',
    tier: 'free',
    hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
    handle: /^\/(?!i\/|home|search|hashtag\/)([A-Za-z0-9_]{1,15})\/?$/,
    featured: 'Follow me on X',
  },
  snapchat: {
    label: 'Snapchat',
    badge: 'SC',
    tier: 'free',
    hosts: ['snapchat.com', 'www.snapchat.com'],
    handle: /^\/(?:add\/|@)([A-Za-z0-9._-]{1,60})\/?$/,
    featured: 'Add me on Snapchat',
  },
  whatsapp: {
    label: 'WhatsApp channel',
    badge: 'WA',
    tier: 'free',
    hosts: ['whatsapp.com', 'www.whatsapp.com'],
    // A channel only: a phone number has its own switch on the page.
    path: /^\/channel\/[A-Za-z0-9]{6,}\/?$/,
    featured: 'Join my WhatsApp channel',
  },
  twitch: {
    label: 'Twitch',
    badge: 'Tw',
    tier: 'free',
    hosts: ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'],
    handle: at('([A-Za-z0-9_]{1,25})'),
    featured: 'Watch me live on Twitch',
  },
  kick: {
    label: 'Kick',
    badge: 'K',
    tier: 'free',
    hosts: ['kick.com', 'www.kick.com'],
    handle: at('([A-Za-z0-9_-]{1,25})'),
    featured: 'Watch me live on Kick',
  },
  audiomack: {
    label: 'Audiomack',
    badge: 'AM',
    tier: 'free',
    hosts: ['audiomack.com', 'www.audiomack.com'],
    handle: at('([A-Za-z0-9_-]{1,60})'),
    featured: 'Listen on Audiomack',
  },
  boomplay: {
    label: 'Boomplay',
    badge: 'BP',
    tier: 'free',
    hosts: ['boomplay.com', 'www.boomplay.com'],
    featured: 'Listen on Boomplay',
  },
  spotify: {
    label: 'Spotify',
    badge: 'SP',
    tier: 'free',
    hosts: ['open.spotify.com'],
    featured: 'Listen on Spotify',
  },
  applemusic: {
    label: 'Apple Music',
    badge: 'AP',
    tier: 'free',
    hosts: ['music.apple.com'],
    featured: 'Listen on Apple Music',
  },
  soundcloud: {
    label: 'SoundCloud',
    badge: 'So',
    tier: 'free',
    hosts: ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'],
    handle: at('([a-z0-9_-]{1,60})'),
    featured: 'Listen on SoundCloud',
  },
  // ---- Pro ----
  website: {
    label: 'Website',
    badge: 'www',
    light: true,
    tier: 'pro',
    hosts: [],
    featured: 'Visit my website',
  },
  telegram: {
    label: 'Telegram',
    badge: 'TG',
    tier: 'pro',
    hosts: ['t.me', 'telegram.me'],
    // Public usernames only: invite links (t.me/+…, t.me/joinchat/…) open private groups.
    path: /^\/(?!joinchat(?:\/|$))[A-Za-z][A-Za-z0-9_]{3,31}\/?$/,
    handle: at('([A-Za-z][A-Za-z0-9_]{3,31})'),
    featured: 'Join me on Telegram',
  },
  linkedin: {
    label: 'LinkedIn',
    badge: 'in',
    tier: 'pro',
    hosts: ['linkedin.com', 'www.linkedin.com'],
    handle: /^\/(in\/[A-Za-z0-9_-]{3,100})\/?$/,
    prefix: '',
    featured: 'Connect on LinkedIn',
  },
  threads: {
    label: 'Threads',
    badge: 'Th',
    tier: 'pro',
    // threads.com since April 2025; threads.net still redirects there.
    hosts: ['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'],
    handle: /^\/@([A-Za-z0-9._]{1,30})\/?$/,
    featured: 'Follow me on Threads',
  },
  patreon: {
    label: 'Patreon',
    badge: 'P',
    light: true,
    tier: 'pro',
    hosts: ['patreon.com', 'www.patreon.com'],
    handle: /^\/(?:c\/)?([A-Za-z0-9_-]{1,64})\/?$/,
    featured: 'Support me on Patreon',
  },
  selar: {
    label: 'Selar',
    badge: 'Se',
    light: true,
    tier: 'pro',
    // selar.com since February 2025; selar.co links still redirect.
    hosts: ['selar.com', 'www.selar.com', 'selar.co'],
    handle: plainName,
    featured: 'See my Selar store',
  },
  substack: {
    label: 'Substack',
    badge: 'Su',
    light: true,
    tier: 'pro',
    hosts: ['substack.com', 'www.substack.com'],
    subdomainsOf: ['substack.com'],
    handle: /^\/@([A-Za-z0-9_-]{1,60})\/?$/,
    featured: 'Read my Substack',
  },
  onlyfans: {
    label: 'OnlyFans',
    badge: '18+',
    light: true,
    tier: 'pro',
    hosts: ['onlyfans.com', 'www.onlyfans.com'],
    handle: plainName,
    featured: 'Find me on OnlyFans',
  },
  fansly: {
    label: 'Fansly',
    badge: '18+',
    light: true,
    tier: 'pro',
    hosts: ['fansly.com', 'www.fansly.com'],
    handle: plainName,
    featured: 'Find me on Fansly',
  },
} as const satisfies Record<string, PlatformSpec>;

export type SocialPlatform = keyof typeof SOCIAL_PLATFORMS;
export const SOCIAL_PLATFORM_KEYS = Object.keys(
  SOCIAL_PLATFORMS,
) as SocialPlatform[];
const spec = (platform: SocialPlatform): PlatformSpec =>
  SOCIAL_PLATFORMS[platform];

export const FREE_LINK_LIMIT = 3;
export const PRO_LINK_LIMIT = 8;
/** Stored, not shown: a Free save on a lapsed Pro page keeps the hidden links after its own 3. */
export const STORED_LINK_LIMIT = PRO_LINK_LIMIT + FREE_LINK_LIMIT;
export const SOCIAL_URL_MAX = 200;

/**
 * Never allowed, as any site or as a website: pages of links (a page of links inside a page of
 * links hides where people end up), music smart-link pages and URL shorteners, which hide it too.
 * Subdomains included. Best effort: new link-in-bio services appear all the time. The list follows
 * the services named in 2026 round-ups (influencermarketinghub.com/linktree-alternatives,
 * replug.io/blog/best-bio-link-tools, limey.io/blog/best-linktree-alternatives) plus the common
 * shorteners.
 */
export const LINK_PAGE_HOSTS = [
  // Link-in-bio pages
  'linktr.ee',
  'linktree.com',
  'linktree.co',
  'beacons.ai',
  'beacons.page',
  'lnk.bio',
  'bio.link',
  'bio.site',
  'campsite.bio',
  'solo.to',
  'tap.bio',
  'taplink.cc',
  'taplink.at',
  'msha.ke',
  'milkshake.app',
  'allmylinks.com',
  'linkin.bio',
  'snipfeed.co',
  'hoo.be',
  'koji.to',
  'withkoji.com',
  'flow.page',
  'linkpop.com',
  'many.link',
  'stan.store',
  'carrd.co',
  'linkr.bio',
  'linkfly.to',
  'heylink.me',
  'linkme.bio',
  'biolinky.co',
  'shor.by',
  'direct.me',
  'contactinbio.com',
  'url.bio',
  'lynk.id',
  'linkbio.co',
  'own.page',
  'unil.ink',
  // Music smart links
  'lnk.to',
  'ffm.to',
  'fanlink.to',
  'fanlink.tv',
  'smarturl.it',
  'song.link',
  'album.link',
  'odesli.co',
  'linkfire.com',
  // Shorteners
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'cutt.ly',
  'rebrand.ly',
  'shorturl.at',
  'tiny.cc',
  's.ee',
] as const;

/** Adult platforms, which the ADULT_PLATFORM_LINKS switch can hide everywhere at once. */
export const ADULT_PLATFORMS = ['onlyfans', 'fansly'] as const;
export const isAdultPlatform = (platform: SocialPlatform) =>
  (ADULT_PLATFORMS as readonly string[]).includes(platform);

const within = (host: string, domains: readonly string[]) =>
  domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

function parseHttps(raw: string): URL | null {
  const value = raw.trim();
  // Whitespace or backslashes inside a link are read differently by browsers, mail and crawlers.
  if (value.length > SOCIAL_URL_MAX || /[\s\\]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    return null;
  return url;
}

/** The form a link is stored in: trimmed, parsed and written back out (lower-case host). */
export function normaliseSocialUrl(value: string): string {
  return parseHttps(value)?.href ?? value;
}

/** Two links are the same link when they differ only by a trailing slash once normalised. */
export const linkKey = (value: string) =>
  normaliseSocialUrl(value).replace(/\/(?=$|[?#])/, '');

function siteOf(url: URL): SocialPlatform | null {
  for (const platform of SOCIAL_PLATFORM_KEYS) {
    const { hosts, subdomainsOf } = spec(platform);
    if (
      hosts.includes(url.hostname) ||
      (subdomainsOf && within(url.hostname, subdomainsOf))
    )
      return platform;
  }
  return null;
}

/** Why this link can't be saved as this site, or null when it can. */
export function socialLinkProblem(
  platform: SocialPlatform,
  value: string,
): null | 'invalid' | 'link_page' | 'listed_site' {
  const url = parseHttps(value);
  if (!url) return 'invalid';
  const host = url.hostname;
  if (platform === 'website') {
    // A real public name: a dot, not an IP address (IPv6 hosts arrive in brackets).
    if (
      !host.includes('.') ||
      host.startsWith('[') ||
      /^\d+(\.\d+){3}$/.test(host) ||
      host.endsWith('.')
    )
      return 'invalid';
    // l.instagram.com, l.facebook.com and the like are the sites' own outbound redirects.
    if (within(host, LINK_PAGE_HOSTS) || /^lm?\./.test(host))
      return 'link_page';
    if (siteOf(url)) return 'listed_site';
    return null;
  }
  if (siteOf(url) !== platform) return 'invalid';
  const { path, subdomainsOf, redirect } = spec(platform);
  if (redirect?.test(url.pathname)) return 'link_page';
  // A publication on its own subdomain is the page itself; elsewhere the bare site is not a page.
  const ownSubdomain =
    subdomainsOf !== undefined &&
    !spec(platform).hosts.includes(host) &&
    within(host, subdomainsOf);
  if (ownSubdomain) return null;
  if (path ? !path.test(url.pathname) : url.pathname.length <= 1)
    return 'invalid';
  return null;
}

/** Which site a pasted link is on: a listed site, otherwise a website, or null if unusable. */
export function detectPlatform(value: string): SocialPlatform | null {
  const url = parseHttps(value.trim());
  if (!url) return null;
  const site = siteOf(url);
  if (site) return site;
  return socialLinkProblem('website', url.href) === null ? 'website' : null;
}

export interface SocialLink {
  platform: SocialPlatform;
  url: string;
  /** The one link drawn as a full-width key above the row (Pro). */
  featured?: true;
}

/** The handle shown on the page, read from the link; null when the link holds none. */
export function linkHandle(link: SocialLink): string | null {
  const url = parseHttps(link.url);
  if (!url) return null;
  if (link.platform === 'website') return url.hostname.replace(/^www\./, '');
  const { handle, prefix = '@', subdomainsOf, hosts } = spec(link.platform);
  if (
    subdomainsOf &&
    !hosts.includes(url.hostname) &&
    within(url.hostname, subdomainsOf)
  )
    return url.hostname;
  const match = handle?.exec(url.pathname);
  return match?.[1] ? `${prefix}${match[1]}` : null;
}

export const socialPlatformSchema = z.enum(
  SOCIAL_PLATFORM_KEYS as [SocialPlatform, ...SocialPlatform[]],
);

export const socialLinkSchema = z
  .object({
    platform: socialPlatformSchema,
    url: z.string().max(SOCIAL_URL_MAX),
    featured: z.literal(true).optional(),
  })
  .strict()
  .superRefine((link, ctx) => {
    const problem = socialLinkProblem(link.platform, link.url);
    if (problem)
      ctx.addIssue({ code: 'custom', message: problem, path: ['url'] });
  })
  .transform((link) => ({ ...link, url: normaliseSocialUrl(link.url) }));

/** Shape and sites only. The plan's limits are checked on the server, against the page's plan. */
export const socialLinksSchema = z
  .array(socialLinkSchema)
  .max(STORED_LINK_LIMIT)
  .superRefine((links, ctx) => {
    const seen = new Set<string>();
    let featured = 0;
    links.forEach((link, index) => {
      if (link.featured && ++featured > 1)
        ctx.addIssue({
          code: 'custom',
          message: 'one_featured',
          path: [index, 'featured'],
        });
      const key = linkKey(link.url);
      if (seen.has(key))
        ctx.addIssue({
          code: 'custom',
          message: 'repeated',
          path: [index, 'url'],
        });
      seen.add(key);
    });
  });

/** PUT /v1/me/links: the whole list, in order, and whether the page shows it. */
export const myLinksSchema = z
  .object({
    links: socialLinksSchema,
    show: z.boolean(),
    /**
     * Free only: the hidden links (kept from Pro) to keep, by URL; any other hidden link is
     * deleted. Omitted, all are kept. Ignored on Pro, which sends its whole list in `links`.
     */
    hidden: z
      .array(z.string().max(SOCIAL_URL_MAX))
      .max(STORED_LINK_LIMIT)
      .optional(),
  })
  .strict();
export type MyLinksRequest = z.infer<typeof myLinksSchema>;

const catalogueIndex = (platform: SocialPlatform) =>
  SOCIAL_PLATFORM_KEYS.indexOf(platform);

/** Free pages list their links in catalogue order; another order is a Pro choice. */
export const inCatalogueOrder = (links: readonly SocialLink[]) =>
  links.every(
    (link, i) =>
      i === 0 ||
      catalogueIndex(links[i - 1]!.platform) <= catalogueIndex(link.platform),
  );

export const sortByCatalogue = (links: readonly SocialLink[]) =>
  [...links].sort(
    (a, b) => catalogueIndex(a.platform) - catalogueIndex(b.platform),
  );

/** True when saving this list needs Pro: a 4th link, a Pro site, a featured link or own order. */
export function linksNeedPro(links: readonly SocialLink[]): boolean {
  return (
    links.length > FREE_LINK_LIMIT ||
    links.some((link) => spec(link.platform).tier === 'pro' || link.featured) ||
    !inCatalogueOrder(links)
  );
}

const unfeatured = ({ platform, url }: SocialLink): SocialLink => ({
  platform,
  url,
});

/** Which stored links show, by position: on Free, the first 3 from Free sites. */
function freeIndexes(links: readonly SocialLink[]): Set<number> {
  const shown = new Set<number>();
  links.forEach((link, index) => {
    if (shown.size < FREE_LINK_LIMIT && spec(link.platform).tier === 'free')
      shown.add(index);
  });
  return shown;
}

/**
 * What the page shows for its plan. Pro: up to 8, as saved. Free (or Pro lapsed): the first 3
 * Free-site links in the saved order, without featured styling. Nothing stored is removed.
 */
export function visibleLinks(
  links: readonly SocialLink[],
  plan: SocialTier,
  /** `adult: false` while ADULT_PLATFORM_LINKS is off: OnlyFans and Fansly don't show. */
  { adult = true }: { adult?: boolean } = {},
): SocialLink[] {
  const allowed = adult
    ? links
    : links.filter((link) => !isAdultPlatform(link.platform));
  if (plan === 'pro') return allowed.slice(0, PRO_LINK_LIMIT);
  const shown = freeIndexes(allowed);
  return allowed.filter((_, index) => shown.has(index)).map(unfeatured);
}

/** The stored links a Free page doesn't show: Pro sites, and Free sites past the first 3. */
export function hiddenOnFree(stored: readonly SocialLink[]): SocialLink[] {
  const shown = freeIndexes(stored);
  return stored.filter((_, index) => !shown.has(index));
}

/**
 * A Free save replaces the links that show on Free; the hidden ones (kept from Pro) follow it,
 * so they are back if Pro returns. `keep` lists the hidden links the owner still wants (by URL):
 * a hidden link left out is deleted. Only stored links can be kept, so a Free page can't add one
 * this way. Omitted, every hidden link is kept. A link saved again isn't kept twice.
 */
export function mergeFreeSave(
  stored: readonly SocialLink[],
  submitted: readonly SocialLink[],
  keep?: readonly string[],
): SocialLink[] {
  const wanted = keep && new Set(keep.map(linkKey));
  const saved = new Set(submitted.map((link) => linkKey(link.url)));
  return [
    ...submitted,
    ...hiddenOnFree(stored).filter(
      (link) =>
        !saved.has(linkKey(link.url)) &&
        (!wanted || wanted.has(linkKey(link.url))),
    ),
  ];
}

/** Links from an API older than this one, which sent three fixed fields. */
export function linksFromLegacy(
  socials: Partial<Record<'facebook' | 'instagram' | 'x', string>> | undefined,
): SocialLink[] {
  return (['facebook', 'instagram', 'x'] as const).flatMap((platform) =>
    socials?.[platform] ? [{ platform, url: socials[platform] }] : [],
  );
}
