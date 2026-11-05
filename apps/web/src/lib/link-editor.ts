import {
  FREE_LINK_LIMIT,
  PRO_LINK_LIMIT,
  SOCIAL_PLATFORMS,
  SOCIAL_PLATFORM_KEYS,
  detectPlatform,
  hiddenOnFree,
  isAdultPlatform,
  linkKey,
  linksFromLegacy,
  mergeFreeSave,
  socialLinkProblem,
  sortByCatalogue,
  visibleLinks,
  type PagePlan,
  type SocialLink,
  type SocialPlatform,
  type Socials,
} from '@tipme/contracts';

// The "Your links" editor (SocialLinks board). The server enforces every rule here again; this
// only shows them early and in plain words.

export interface LinkRow {
  /** Stable while the row moves, so React keeps its input (and focus) with it. */
  id: string;
  platform: SocialPlatform;
  url: string;
  featured: boolean;
}

let next = 0;
const rowOf = (link: SocialLink): LinkRow => ({
  id: `link-${++next}`,
  platform: link.platform,
  url: link.url,
  featured: link.featured === true,
});

export const limitFor = (plan: PagePlan) =>
  plan === 'pro' ? PRO_LINK_LIMIT : FREE_LINK_LIMIT;

/** The three fields an API from before social links (5 Nov 2026) can save. */
export const LEGACY_SITES = ['facebook', 'instagram', 'x'] as const;

/**
 * The rows to edit. Pro edits everything stored. Free edits what shows on Free, and lists the links
 * a lapsed Pro page keeps (`hidden`), which it may remove but not add or show. An older API (no
 * `links` in the profile) can only take Facebook, Instagram and X, through the profile route.
 */
export function editorFrom(profile: {
  plan?: PagePlan;
  links?: SocialLink[];
  socials?: Socials;
  adultLinks?: boolean;
}) {
  const legacy = profile.links === undefined;
  const plan: PagePlan = legacy ? 'free' : (profile.plan ?? 'free');
  const stored = profile.links ?? linksFromLegacy(profile.socials);
  const editable =
    plan === 'pro' ? stored : sortByCatalogue(visibleLinks(stored, 'free'));
  const sites: SocialPlatform[] = legacy
    ? [...LEGACY_SITES]
    : SOCIAL_PLATFORM_KEYS.filter(
        (site) =>
          (plan === 'pro' || SOCIAL_PLATFORMS[site].tier === 'free') &&
          (profile.adultLinks !== false || !isAdultPlatform(site)),
      );
  return {
    rows: editable.map(rowOf),
    hidden: plan === 'pro' ? [] : hiddenOnFree(stored),
    limit: legacy ? LEGACY_SITES.length : limitFor(plan),
    plan,
    legacy,
    sites,
  };
}

/** The old profile route's body: the first link of each of the three sites, and the switch. */
export function legacyPatch(rows: LinkRow[], show: boolean) {
  const socials: Socials = {};
  for (const row of rows)
    if (
      (LEGACY_SITES as readonly string[]).includes(row.platform) &&
      row.url.trim() &&
      !socials[row.platform as (typeof LEGACY_SITES)[number]]
    )
      socials[row.platform as (typeof LEGACY_SITES)[number]] = row.url.trim();
  return { socials, socialsPublic: show };
}

export type HiddenStatus = 'pro' | 'over_limit' | 'will_show';

/**
 * Each link a Free page keeps from Pro, and what saving now would do with it: a Pro site never
 * shows on Free; a Free site past the first 3 stays hidden, unless removing a shown link lets it
 * move up, which the editor says before the save.
 */
export function hiddenStatus(
  stored: readonly SocialLink[],
  rows: LinkRow[],
  kept: readonly SocialLink[],
): { link: SocialLink; status: HiddenStatus }[] {
  const after = new Set(
    visibleLinks(
      mergeFreeSave(
        stored,
        toRequest(rows, 'free'),
        kept.map((link) => link.url),
      ),
      'free',
    ).map((link) => linkKey(link.url)),
  );
  return kept.map((link) => ({
    link,
    status: after.has(linkKey(link.url))
      ? 'will_show'
      : SOCIAL_PLATFORMS[link.platform].tier === 'pro'
        ? 'pro'
        : 'over_limit',
  }));
}

/** Rows past what the plan shows (a returning Pro page can hold 11): they don't show. */
export const notShown = (rows: LinkRow[], plan: PagePlan) =>
  rows.slice(limitFor(plan));

export function addRow(
  rows: LinkRow[],
  platform: SocialPlatform,
  plan: PagePlan,
  url = '',
): LinkRow[] {
  const row = rowOf({ platform, url });
  if (plan === 'pro') return [...rows, row];
  const at = rows.findIndex((other) => order(other.platform) > order(platform));
  return at < 0
    ? [...rows, row]
    : [...rows.slice(0, at), row, ...rows.slice(at)];
}

const order = (platform: SocialPlatform) =>
  Object.keys(SOCIAL_PLATFORMS).indexOf(platform);

export function moveRow(
  rows: LinkRow[],
  index: number,
  delta: number,
): LinkRow[] {
  const to = index + delta;
  if (to < 0 || to >= rows.length || index < 0 || index >= rows.length)
    return rows;
  const copy = [...rows];
  const [row] = copy.splice(index, 1);
  copy.splice(to, 0, row!);
  return copy;
}

/** One featured link at most: choosing another moves the star; choosing it again removes it. */
export const toggleFeatured = (rows: LinkRow[], index: number) =>
  rows.map((row, i) => ({
    ...row,
    featured: i === index ? !row.featured : false,
  }));

/** Pasting another listed site's link into a row makes the row that site. */
export function setRowUrl(
  rows: LinkRow[],
  index: number,
  value: string,
): LinkRow[] {
  return rows.map((row, i) => {
    if (i !== index) return row;
    const url = value.trim();
    const found = detectPlatform(url);
    return {
      ...row,
      url,
      platform: found && found !== 'website' ? found : row.platform,
    };
  });
}

const an = (label: string) => (/^[AEIOU]/.test(label) ? 'an' : 'a');

function problemOf(row: LinkRow, plan: PagePlan): string | null {
  const { label, tier } = SOCIAL_PLATFORMS[row.platform];
  if (!row.url) return `Paste your ${label} link, or remove this row.`;
  if (plan !== 'pro' && tier === 'pro')
    return `${label} links are part of TipMe Pro.`;
  const problem = socialLinkProblem(row.platform, row.url);
  if (problem === 'link_page')
    return 'Link pages and short links aren’t supported. Add each site on its own.';
  if (problem === 'listed_site') {
    const site = detectPlatform(row.url)!;
    const name = SOCIAL_PLATFORMS[site].label;
    return `That’s ${an(name)} ${name} link. Add it as ${name}.`;
  }
  if (problem === 'invalid') {
    if (row.platform === 'whatsapp')
      return 'Use your channel’s link, https://whatsapp.com/channel/…, not a phone number.';
    if (row.platform === 'telegram')
      return 'Use your public https://t.me/ link, not an invite link.';
    if (row.platform === 'website')
      return 'Use a full https:// link to your website.';
    return `Use a full https:// link to your ${label} page.`;
  }
  return null;
}

/** A message per row id, for the rows that can't be saved as they are. */
export function rowProblems(
  rows: LinkRow[],
  plan: PagePlan,
): Record<string, string> {
  const problems: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const problem =
      problemOf(row, plan) ??
      (seen.has(row.url) ? 'You’ve added this link already.' : null);
    if (problem) problems[row.id] = problem;
    if (row.url) seen.add(row.url);
  }
  return problems;
}

/** The list as PUT /v1/me/links takes it: Free in catalogue order with nothing featured. */
export function toRequest(rows: LinkRow[], plan: PagePlan): SocialLink[] {
  const links = rows.map(({ platform, url, featured }) => ({
    platform,
    url,
    ...(featured && plan === 'pro' ? { featured: true as const } : {}),
  }));
  return plan === 'pro' ? links : sortByCatalogue(links);
}

/** What the page would show as typed now: usable links only, as the plan shows them. */
export const shownLinks = (rows: LinkRow[], plan: PagePlan) =>
  visibleLinks(
    toRequest(
      rows.filter((row) => socialLinkProblem(row.platform, row.url) === null),
      plan,
    ),
    plan,
  );
