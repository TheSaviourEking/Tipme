'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, type ComponentProps } from 'react';
import { onProfilePage } from '@/lib/profile-path';

// Re-exported for the header: its links don't prefetch on a public profile. A styled profile shows
// the header (ruling P), and its visitor came to tip, not to load other pages' script (the Studio
// page's 3 KB script budget, tests/e2e/studio-page.spec.ts).
export { onProfilePage };

/** A header link that prefetches everywhere but on a profile page. */
export function NavLink(props: ComponentProps<typeof Link>) {
  // Reading the address waits for the browser, so it has its own boundary; until then, no prefetch.
  return (
    <Suspense fallback={<Link {...props} prefetch={false} />}>
      <RoutedLink {...props} />
    </Suspense>
  );
}

function RoutedLink(props: ComponentProps<typeof Link>) {
  const profile = onProfilePage(usePathname());
  return <Link {...props} {...(profile ? { prefetch: false } : {})} />;
}
