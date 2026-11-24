/**
 * The header's "Who it's for" menu: three rows (owner's reference, 24 Nov 2026). Giving is not
 * open yet, so it says so and is not a link. `icon` is the 24x24 line-icon path data.
 */
export const WHO = [
  {
    title: 'Individual',
    href: '/for-creators',
    text: 'Receive tips as an individual.',
    // A person: head and shoulders.
    icon: 'M12 3.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4.5 20.5c0-4.1 3.4-7 7.5-7s7.5 2.9 7.5 7',
  },
  {
    title: 'Business',
    href: '/for-businesses',
    text: 'Receive and manage tips for businesses and their employees.',
    // A storefront: awning above a door.
    icon: 'M4 9.5 5.5 4h13L20 9.5ZM4 9.5c0 1.4 1.1 2.5 2.7 2.5S9.3 10.9 9.3 9.5c0 1.4 1.1 2.5 2.7 2.5s2.7-1.1 2.7-2.5c0 1.4 1.1 2.5 2.6 2.5S20 10.9 20 9.5M5.5 12v8.5h13V12M10 20.5v-5h4v5',
    // The words follow the business flag when the layout passes them (`businesses`, PR B1).
    flagged: true,
  },
  {
    title: 'Giving',
    href: undefined,
    text: 'Receive and manage contributions for churches, organisations and causes.',
    // An open hand holding a heart.
    icon: 'M12 11.5C9.2 9.2 8.5 7.6 8.5 6.4A2.2 2.2 0 0 1 12 4.7a2.2 2.2 0 0 1 3.5 1.7c0 1.2-.7 2.8-3.5 5.1ZM3 15.5h3l3 1.5h4.5a1.5 1.5 0 0 1 0 3H9.5M13.5 18l6-2.2a1.7 1.7 0 0 1 1.5 3l-6.5 2.7H8l-2-1.5H3',
    comingSoon: true,
  },
] as const;
