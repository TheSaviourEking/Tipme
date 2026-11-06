'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@tipme/ui';
import { Wordmark } from '@/components/brand';
import {
  opsMenuCurrent,
  opsMenuGroups,
  type OpsMenuFeatures,
  type OpsMenuGroup,
} from '@/lib/ops-menu';

/** From here the sidebar shows; below it, the Menu sheet (keep in step with `.ops-frame` CSS). */
const WIDE = '(min-width: 1024px)';

/**
 * The menu, in the sidebar or in the sheet. Only one is ever displayed, so only one
 * `nav[aria-label="Admin"]` is in the accessibility tree: the sidebar is `display: none` below
 * 1024px, and a closed dialog is not rendered at all by the browser.
 */
function AdminNav({
  groups,
  pathname,
  approvals,
  onLeave,
  onChoose,
  sheet = false,
  ref,
}: {
  groups: OpsMenuGroup[];
  pathname: string;
  approvals: ReactNode;
  onLeave: () => void;
  onChoose?: () => void;
  sheet?: boolean;
  ref?: React.Ref<HTMLElement>;
}) {
  return (
    <nav
      aria-label="Admin"
      ref={ref}
      className={sheet ? 'ops-frame__nav' : 'ops-frame__side'}
    >
      {!sheet && (
        <div className="ops-frame__mark" aria-hidden="true">
          <Wordmark className="ops-frame__wordmark" />
          <span className="ops-frame__pill">Admin</span>
        </div>
      )}
      {groups.map((group) => (
        <div key={group.label ?? 'top'} className="ops-frame__group">
          {group.label && (
            // In the sheet the labels are heard, not seen: the board draws the links alone there.
            <h2 className={sheet ? 'sr-only' : 'ops-frame__label'}>
              {group.label}
            </h2>
          )}
          <ul
            className={
              sheet && group.label
                ? 'ops-frame__links ops-frame__links--split'
                : 'ops-frame__links'
            }
          >
            {group.links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  aria-current={pathname === link.href ? 'page' : undefined}
                  onClick={onChoose}
                >
                  {link.label}
                  {link.href === '/ops/approvals' && approvals}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="ops-frame__leave">
        <Button variant="quiet" onClick={onLeave}>
          Leave admin
        </Button>
      </div>
    </nav>
  );
}

/**
 * The admin frame (OpsShell board): a grouped sidebar from 1024px, and below it the staff strip, a
 * bar with "Menu · {page}" and a sheet. Shown only once access is granted; the shell keeps the
 * plain layout for every other state.
 */
export function OpsFrame({
  permissions,
  features,
  pathname,
  approvals,
  onLeave,
  children,
}: {
  permissions: readonly string[];
  /** Feature-gated links that are switched on (Businesses while the business flag is on). */
  features?: OpsMenuFeatures;
  pathname: string;
  /** The waiting count on the Approvals link (null for none). */
  approvals: ReactNode;
  onLeave: () => void;
  /** The fresh-code prompt and the page. */
  children: ReactNode;
}) {
  const groups = opsMenuGroups(permissions, features);
  const current = opsMenuCurrent(
    groups.flatMap((group) => group.links),
    pathname,
  );
  const side = useRef<HTMLElement>(null);
  const sheet = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // A tall menu scrolls inside the sidebar: keep the open page's link in view there.
  useEffect(() => {
    side.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);

  // A window widened past the breakpoint gets the sidebar, so the sheet goes.
  useEffect(() => {
    const wide = matchMedia(WIDE);
    const close = () => {
      if (wide.matches) sheet.current?.close();
    };
    wide.addEventListener('change', close);
    return () => wide.removeEventListener('change', close);
  }, []);

  // Back and forward don't pass through a link: the sheet still closes on a new page.
  useEffect(() => {
    sheet.current?.close();
  }, [pathname]);

  const openSheet = () => {
    sheet.current?.showModal();
    setOpen(true);
  };
  const closeSheet = () => sheet.current?.close();

  return (
    <div className="ops-frame">
      <AdminNav
        ref={side}
        groups={groups}
        pathname={pathname}
        approvals={approvals}
        onLeave={onLeave}
      />
      <div className="ops-frame__column">
        <div className="ops-banner" role="note">
          <strong>Admin</strong>
          <span>Staff area · every view and action is recorded</span>
        </div>
        <div className="ops-frame__bar">
          <Wordmark className="ops-frame__wordmark" />
          <Button
            ref={menuButton}
            variant="secondary"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={openSheet}
          >
            {current ? `Menu · ${current.label}` : 'Menu'}
          </Button>
          <dialog
            ref={sheet}
            className="ops-frame__sheet"
            aria-label="Admin menu"
            onClose={() => {
              setOpen(false);
              menuButton.current?.focus({ preventScroll: true });
            }}
            onClick={(event) => {
              // A tap on the dimmed page lands on the dialog itself, never on its content.
              if (event.target === event.currentTarget) closeSheet();
            }}
          >
            <div className="ops-frame__sheet-body">
              <div className="ops-frame__grab" aria-hidden="true" />
              <AdminNav
                sheet
                groups={groups}
                pathname={pathname}
                approvals={approvals}
                onLeave={onLeave}
                onChoose={closeSheet}
              />
            </div>
          </dialog>
        </div>
        <main
          id="main"
          tabIndex={-1}
          className="dashboard-page ops-page ops-frame__content"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
