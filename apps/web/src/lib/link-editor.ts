import {
  FREE_LINK_LIMIT,
  PRO_LINK_LIMIT,
  SOCIAL_PLATFORMS,
  detectPlatform,
  linksFromLegacy,
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

/**
 * The rows to edit. Pro edits everything stored. Free edits what shows on Free; links a lapsed Pro
 * page keeps are counted in `hidden` and stay stored (the server keeps them on a Free save).
 */
export function editorFrom(profile: {
  plan?: PagePlan;
  links?: SocialLink[];
  socials?: Socials;
}) {
  const plan = profile.plan ?? 'free';
  const stored = profile.links ?? linksFromLegacy(profile.socials);
  const editable =
    plan === 'pro' ? stored : sortByCatalogue(visibleLinks(stored, 'free'));
  return {
    rows: editable.map(rowOf),
    hidden: stored.length - editable.length,
    limit: limitFor(plan),
  };
}

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
