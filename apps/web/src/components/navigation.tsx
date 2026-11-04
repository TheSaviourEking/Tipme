'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { ActionLink, Button, Container, Surface } from '@tipme/ui';
import { Brand, Arrow } from './brand';

/**
 * Who the product is for. Individuals is open; the other two say so and are not links until
 * there is somewhere to go (Infrastructure has no page). Wording: owner, 3 Nov 2026.
 */
const WHO = [
  {
    title: 'Individuals',
    href: '/for-creators',
    text: 'Creators, streamers, video editors, barbers, drivers: anyone can receive payments.',
  },
  {
    title: 'Businesses (coming soon)',
    href: '/for-businesses',
    text: "Tell us you're interested, and we'll let you know.",
  },
  {
    title: 'Infrastructure (coming soon)',
    href: undefined,
    text: 'Consume the Tipme APIs.',
  },
] as const;

function MenuIcon({ path }: { path: string }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

/** Reading the address makes a page wait for the browser, so it sits in its own boundary. */
function ProLink({ onClick }: { onClick(): void }) {
  const onPro = usePathname() === '/pro';
  return (
    <Link
      href="/pro"
      aria-current={onPro ? 'page' : undefined}
      onClick={onClick}
    >
      Pro
    </Link>
  );
}

export function Navigation() {
  const [open, setOpen] = useState(false);
  const [whoOpen, setWhoOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const who = useRef<HTMLButtonElement>(null);
  const whoGroup = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLElement>(null);
  // Set by Escape and the close button only: following a link must not pull focus back here.
  const returnFocus = useRef(false);

  // On a phone the open menu is a page of its own: focus starts on its close button, and goes
  // back to the button that opened it once it is closed.
  useEffect(() => {
    if (open) closeButton.current?.focus();
    else if (returnFocus.current) toggle.current?.focus();
    returnFocus.current = false;
  }, [open]);

  // On a wide screen the choices are a popover: a press anywhere else puts it away. On a phone
  // they are always shown inside the open menu, so this has nothing to close.
  useEffect(() => {
    if (!whoOpen) return;
    const away = (event: PointerEvent) => {
      if (!whoGroup.current?.contains(event.target as Node)) setWhoOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [whoOpen]);

  const close = () => {
    setOpen(false);
    setWhoOpen(false);
  };

  const closeMenu = () => {
    returnFocus.current = true;
    close();
  };

  return (
    <header
      className={`site-header ${open ? 'is-menu-open' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // Focus goes back to the control that was opened, whichever one is on screen.
          const popover = whoOpen && who.current?.offsetParent != null;
          if (popover) {
            close();
            who.current?.focus();
          } else if (open) closeMenu();
          return;
        }
        // The open phone menu covers the page: Tab goes round inside it, never into the page.
        const nav = menu.current;
        if (event.key !== 'Tab' || !open || !nav) return;
        if (getComputedStyle(nav).position !== 'fixed') return;
        const stops = [
          ...nav.querySelectorAll<HTMLElement>('a[href], button'),
        ].filter((el) => el.getClientRects().length > 0);
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <Container className="nav-shell">
        <Brand />
        <Button
          className="menu-toggle"
          variant="secondary"
          ref={toggle}
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="site-navigation"
          onClick={() => setOpen(!open)}
        >
          <MenuIcon path="M3 6h18M3 12h18M3 18h18" />
        </Button>
        <nav
          id="site-navigation"
          ref={menu}
          aria-label="Main navigation"
          className={`site-nav ${open ? 'is-open' : ''}`}
        >
          {/* Phone only, in the open menu (PhonePages): the logo and a close button, in the places
              the closed header's own logo and button hold. */}
          <div className="site-nav__bar">
            <Brand />
            <Button
              className="menu-toggle menu-toggle--close"
              variant="secondary"
              ref={closeButton}
              aria-label="Close menu"
              aria-expanded={open}
              aria-controls="site-navigation"
              onClick={closeMenu}
            >
              <MenuIcon path="M5 5l14 14M19 5 5 19" />
            </Button>
          </div>
          {/* The steps live on Home (the owner, 3 Nov 2026); on Home the page glides down to them. */}
          <Link href="/#how-it-works" onClick={close}>
            How it works
          </Link>
          <div
            ref={whoGroup}
            className={`who ${whoOpen ? 'is-open' : ''}`}
            onBlur={(event) => {
              // Tabbing out of the group closes it; a press on the page is handled above.
              if (
                event.relatedTarget &&
                !event.currentTarget.contains(event.relatedTarget as Node)
              )
                setWhoOpen(false);
            }}
          >
            <button
              type="button"
              ref={who}
              className="who__button"
              aria-expanded={whoOpen}
              aria-controls="who-menu"
              onClick={() => setWhoOpen(!whoOpen)}
            >
              Who it&apos;s for
              <svg
                className="who__chevron"
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M2 4.5 6 8.5 10 4.5" />
              </svg>
            </button>
            {/* In the open phone menu there is no button to press: this is a heading instead. */}
            <p className="who__label">Who it&apos;s for</p>
            <Surface material="instrument" id="who-menu" className="who__menu">
              <ul>
                {WHO.map(({ title, href, text }) => (
                  <li key={title}>
                    {href ? (
                      <Link
                        href={href}
                        className="who__item"
                        data-who-item
                        onClick={close}
                      >
                        <strong>{title}</strong>
                        <span>{text}</span>
                      </Link>
                    ) : (
                      <div className="who__item" data-who-item>
                        <strong>{title}</strong>
                        <span>{text}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Surface>
          </div>
          <Suspense fallback={<Link href="/pro">Pro</Link>}>
            <ProLink onClick={close} />
          </Suspense>
          {/* Guest actions; hidden in the dashboard, where someone already has a page (CSS). */}
          <ActionLink
            className="nav-guest"
            variant="secondary"
            href="/sign-in"
            onClick={close}
          >
            Sign in
          </ActionLink>
          {/* Getting someone their own page is the one primary action. */}
          <ActionLink className="nav-guest" href="/sign-up" onClick={close}>
            Create your page <Arrow />
          </ActionLink>
        </nav>
      </Container>
    </header>
  );
}
