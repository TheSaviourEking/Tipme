/**
 * The Studio lab is a test harness: a 404 in a production build unless it is a test copy, the
 * same gate as /dev/inbox and /dev/crash (NEXT_PUBLIC_PRETEND_DELIVERY, set by the e2e build,
 * review screens and local staging only; docs/runbooks/production.md).
 */
export const studioLabOpen = () =>
  process.env.NODE_ENV !== 'production' ||
  process.env.NEXT_PUBLIC_PRETEND_DELIVERY === 'on';
