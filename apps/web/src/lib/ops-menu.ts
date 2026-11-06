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

/** Each entry names what its page reads, so nobody is offered a page that would refuse them. */
const LINKS: { href: string; label: string; needs: string[] | null }[] = [
  { href: '/ops', label: 'Overview', needs: null },
  { href: '/ops/approvals', label: 'Approvals', needs: null },
  { href: '/ops/issues', label: 'Issues', needs: ['issues.view'] },
  { href: '/ops/visibility', label: 'Visibility', needs: ['analytics.view'] },
  { href: '/ops/market', label: 'Market', needs: ['analytics.view'] },
  { href: '/ops/pages', label: 'Pages', needs: [...PAGE_CARDS] },
  { href: '/ops/usernames', label: 'Usernames', needs: ['usernames.manage'] },
  { href: '/ops/search', label: 'Search', needs: ['search.view'] },
  {
    href: '/ops/providers',
    label: 'Providers',
    needs: ['issues.view', 'providers.manage'],
  },
  {
    href: '/ops/email',
    label: 'Email',
    needs: ['issues.view', 'email.read', 'email.export'],
  },
  { href: '/ops/audit', label: 'Audit log', needs: ['audit.view'] },
  { href: '/ops/staff/people', label: 'People', needs: ['staff.manage'] },
  { href: '/ops/staff/roles', label: 'Roles', needs: ['staff.manage'] },
  { href: '/ops/staff', label: 'Your access', needs: null },
];

/** The admin menu for these permissions (the server still checks every call). */
export function opsMenu(permissions: readonly string[]) {
  return LINKS.filter(
    (link) =>
      !link.needs || link.needs.some((needed) => permissions.includes(needed)),
  ).map(({ href, label }) => ({ href, label }));
}
