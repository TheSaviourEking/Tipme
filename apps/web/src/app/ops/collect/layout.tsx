'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { can, useOpsAccess } from '@/lib/ops-client';
import { COLLECT_TABS } from '@/lib/collect-ops-words';

/**
 * You collect's staff area (plan Task 15, spec §9): one menu entry, its screens as tabs. Each tab
 * shows only to whoever can read it; the server checks every call whatever is shown.
 */
export default function CollectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = useOpsAccess();
  const pathname = usePathname();
  const tabs = COLLECT_TABS.filter((tab) => can(access, tab.needs));
  const current = (href: string) =>
    href === '/ops/collect'
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <>
      <nav aria-label="You collect" className="ops-collect-tabs">
        <ul>
          {tabs.map((tab) => (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={current(tab.href) ? 'page' : undefined}
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {children}
    </>
  );
}
