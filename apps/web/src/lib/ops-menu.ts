// Whoever holds one has a card on the Pages screen (OPS_PAGE_LOOKUP_PERMISSIONS; this file imports
// nothing so it can be tested alone).
const PAGE_CARDS = [
  'pages.plan',
  'pages.suspend',
  'fees.manage',
  'payouts.resolve',
  'recoveries.manage',
  // The page card offers "Take back this username".
  'usernames.manage',
];

/** The menu's groups, in the order the OpsShell board draws them; the first has no label. */
const GROUPS = [null, 'Work', 'Numbers', 'Email and records', 'Staff'] as const;
type Group = (typeof GROUPS)[number];

/** Features that are switched off by default; a link tied to one shows only while it is on. */
type OpsMenuFeature = 'business';
export type OpsMenuFeatures = Partial<Record<OpsMenuFeature, boolean>>;

/**
 * Each entry names what its page reads, so nobody is offered a page that would refuse them, and the
 * group it is listed in. A new page is one line here.
 */
const LINKS: {
  href: string;
  label: string;
  group: Group;
  needs: string[] | null;
  /** Shown only while that feature is on (the API answers 404 otherwise). */
  feature?: OpsMenuFeature;
}[] = [
  { href: '/ops', label: 'Overview', group: null, needs: null },
  { href: '/ops/approvals', label: 'Approvals', group: null, needs: null },
  {
    href: '/ops/issues',
    label: 'Issues',
    group: 'Work',
    needs: ['issues.view'],
  },
  {
    href: '/ops/search',
    label: 'Search',
    group: 'Work',
    needs: ['search.view'],
  },
  { href: '/ops/pages', label: 'Pages', group: 'Work', needs: [...PAGE_CARDS] },
  {
    href: '/ops/usernames',
    label: 'Usernames',
    group: 'Work',
    needs: ['usernames.manage'],
  },
  {
    // Paid Pro (ADR-0015): the monthly price, for new months only.
    href: '/ops/pro-price',
    label: 'Pro price',
    group: 'Work',
    needs: ['pro.price'],
  },
  {
    href: '/ops/businesses',
    label: 'Businesses',
    group: 'Work',
    needs: ['search.view'],
    feature: 'business',
  },
  {
    href: '/ops/visibility',
    label: 'Visibility',
    group: 'Numbers',
    needs: ['analytics.view'],
  },
  {
    href: '/ops/market',
    label: 'Market',
    group: 'Numbers',
    needs: ['analytics.view'],
  },
  {
    href: '/ops/providers',
    label: 'Providers',
    group: 'Email and records',
    needs: ['issues.view', 'providers.manage'],
  },
  {
    // Feature switches (owner, 14 Nov 2026): on and off for features, set here, not in settings files.
    href: '/ops/switches',
    label: 'Switches',
    group: 'Email and records',
    needs: ['switches.manage'],
  },
  {
    href: '/ops/email',
    label: 'Email',
    group: 'Email and records',
    needs: ['issues.view', 'email.read', 'email.export'],
  },
  {
    href: '/ops/audit',
    label: 'Audit log',
    group: 'Email and records',
    needs: ['audit.view'],
  },
  {
    // Editors and publishers both read it; the entry page offers Approve or Ask for approval.
    href: '/ops/changelog',
    label: 'Changelog',
    group: 'Email and records',
    needs: ['changelog.edit', 'changelog.publish'],
  },
  {
    href: '/ops/staff/people',
    label: 'People',
    group: 'Staff',
    needs: ['staff.manage'],
  },
  {
    href: '/ops/staff/roles',
    label: 'Roles',
    group: 'Staff',
    needs: ['staff.manage'],
  },
  { href: '/ops/staff', label: 'Your access', group: 'Staff', needs: null },
];

export type OpsMenuLink = { href: string; label: string };
export type OpsMenuGroup = { label: string | null; links: OpsMenuLink[] };

/** The admin menu's groups for these permissions; a group with no links left is dropped. */
export function opsMenuGroups(
  permissions: readonly string[],
  features: OpsMenuFeatures = {},
): OpsMenuGroup[] {
  const allowed = LINKS.filter(
    (link) =>
      (!link.feature || features[link.feature] === true) &&
      (!link.needs ||
        link.needs.some((needed) => permissions.includes(needed))),
  );
  return GROUPS.map((label) => ({
    label,
    links: allowed
      .filter((link) => link.group === label)
      .map(({ href, label: name }) => ({ href, label: name })),
  })).filter((group) => group.links.length > 0);
}

/** The admin menu for these permissions, in order (the server still checks every call). */
export function opsMenu(
  permissions: readonly string[],
  features: OpsMenuFeatures = {},
): OpsMenuLink[] {
  return opsMenuGroups(permissions, features).flatMap((group) => group.links);
}

/**
 * The link for the open page: its own, else the section it sits in (an issue is under Issues).
 * Overview is never a section, so an unlisted page has none.
 */
export function opsMenuCurrent(
  links: readonly OpsMenuLink[],
  pathname: string,
): OpsMenuLink | null {
  const exact = links.find((link) => link.href === pathname);
  if (exact) return exact;
  return (
    links
      .filter((link) => link.href !== '/ops')
      .filter((link) => pathname.startsWith(`${link.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0] ?? null
  );
}
