'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { MyAccount, MyBusinessRoles } from '@tipme/contracts';
import { currentHat, hatHref, hatLabel, hatsOf, type Hat } from '@/lib/hats';

// Business sign-up, Task D6: the account menu. The top-right button says which hat is worn and its
// menu moves between them (a menu button: arrows move, Escape closes and returns focus). On a phone
// the same menu opens as a sheet under the bar (CSS).

const LAST_HAT = 'tipme.last-hat';

function rememberHat(href: string) {
  try {
    localStorage.setItem(LAST_HAT, href);
  } catch {
    // Storage blocked: the button falls back to the first hat.
  }
}
function lastHat(): string | null {
  try {
    return localStorage.getItem(LAST_HAT);
  } catch {
    return null;
  }
}

const initial = (name: string) =>
  (Array.from(name.replace(/^@/, '').trim())[0] ?? '·').toUpperCase();

function hatDetail(hat: Hat): string {
  if (hat.kind === 'page') return `@${hat.handle}`;
  if (hat.kind === 'work') return `Staff · ${hat.locationName}`;
  const role = hat.kind === 'owner' ? 'Owner' : 'Manager';
  if (hat.status === 'pending') return `${role} · Waiting for TipMe`;
  if (hat.status === 'suspended') return `${role} · Paused by TipMe`;
  return hat.plan === 'pro'
    ? `${role} · Business Pro`
    : hat.plan === 'free'
      ? `${role} · Business Free`
      : role;
}

export function HatSwitcher({
  account,
  roles,
  personName,
  onSignOut,
}: {
  account: MyAccount;
  roles: MyBusinessRoles | null;
  /** The page's own name, for a login with only its page (the button reads their name). */
  personName: string | null;
  onSignOut: () => void;
}) {
  const id = useId();
  const pathname = usePathname();
  // Open on one address only: a new page closes it.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const setOpen = (next: boolean | ((was: boolean) => boolean)) =>
    setOpenAt((at) => {
      const was = at === pathname;
      return (typeof next === 'function' ? next(was) : next) ? pathname : null;
    });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const hats = hatsOf(account, roles);

  // The address's query, read in the browser (the dashboard draws only there, once signed in).
  const search = typeof window === 'undefined' ? '' : window.location.search;
  const worn = currentHat(hats, pathname, search);
  useEffect(() => {
    if (worn) rememberHat(hatHref(worn));
  }, [worn]);
  // Settings, help and What's new belong to the login: the last hat used names the button.
  const shown =
    worn ?? hats.find((hat) => hatHref(hat) === lastHat()) ?? hats[0] ?? null;
  const label =
    hats.length === 1 && shown?.kind === 'page' && personName
      ? personName
      : shown
        ? hatLabel(shown)
        : 'Account';

  const items = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target))
        setOpenAt(null);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(all.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') close(false);
  };
  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  };

  const item = (hat: Hat): ReactNode => {
    const href = hatHref(hat);
    const name = hatLabel(hat);
    const pending =
      (hat.kind === 'owner' || hat.kind === 'manager') &&
      hat.status === 'pending';
    return (
      <Link
        key={`${hat.kind}-${'businessId' in hat ? hat.businessId : 'memberId' in hat ? hat.memberId : hat.handle}`}
        href={href}
        role="menuitem"
        tabIndex={-1}
        className="hat-menu__item"
        aria-current={hat === worn ? 'true' : undefined}
        onClick={() => {
          rememberHat(href);
          setOpen(false);
        }}
      >
        <span className="hat-menu__initial" aria-hidden="true">
          {initial(hat.kind === 'work' ? hat.businessName : name)}
        </span>
        <span className="hat-menu__words">
          <span className="hat-menu__name">{name}</span>
          <span className="hat-menu__detail">{hatDetail(hat)}</span>
        </span>
        {pending && <span className="hat-menu__tag">Pending</span>}
      </Link>
    );
  };
  const group = (title: string, of: Hat[]) =>
    of.length > 0 && (
      <div role="group" aria-label={title} className="hat-menu__group">
        <p className="hat-menu__heading" aria-hidden="true">
          {title}
        </p>
        {of.map(item)}
      </div>
    );
  const page = hats.filter((hat) => hat.kind === 'page');
  const you =
    page.length > 0 ? (
      group('You', page)
    ) : (
      <div role="group" aria-label="You" className="hat-menu__group">
        <p className="hat-menu__heading" aria-hidden="true">
          You
        </p>
        <Link
          href="/dashboard/settings#own-page"
          role="menuitem"
          tabIndex={-1}
          className="hat-menu__item"
          onClick={() => setOpen(false)}
        >
          <span className="hat-menu__initial" aria-hidden="true">
            +
          </span>
          <span className="hat-menu__words">
            <span className="hat-menu__name">Turn on your page</span>
            <span className="hat-menu__detail">
              Get tips yourself, on this login
            </span>
          </span>
        </Link>
      </div>
    );

  return (
    <div className="hat-switcher">
      <button
        ref={button}
        type="button"
        className="hat-switcher__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={onButtonKey}
      >
        <span className="hat-menu__initial" aria-hidden="true">
          {initial(label)}
        </span>
        <span className="hat-switcher__label">
          <span className="sr-only">Account: </span>
          {label}
        </span>
      </button>
      {open && (
        <div
          ref={menu}
          id={`${id}-menu`}
          role="menu"
          aria-label="Switch account"
          className="hat-menu"
          onKeyDown={onMenuKey}
        >
          {page.length > 0 && you}
          {group(
            'Businesses you own',
            hats.filter((hat) => hat.kind === 'owner'),
          )}
          {group(
            'Businesses you manage',
            hats.filter((hat) => hat.kind === 'manager'),
          )}
          {page.length === 0 && you}
          {group(
            'Where I work',
            hats.filter((hat) => hat.kind === 'work'),
          )}
          <div className="hat-menu__end">
            <Link
              href="/dashboard/business/apply"
              role="menuitem"
              tabIndex={-1}
              className="hat-menu__plain"
              onClick={() => setOpen(false)}
            >
              Add a business <span aria-hidden="true">+</span>
            </Link>
            <Link
              href="/dashboard/settings"
              role="menuitem"
              tabIndex={-1}
              className="hat-menu__plain"
              onClick={() => setOpen(false)}
            >
              Settings
            </Link>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="hat-menu__plain"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
