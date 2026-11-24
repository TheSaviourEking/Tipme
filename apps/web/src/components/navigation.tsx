'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Container, Surface } from '@tipme/ui';
import { Brand } from './brand';
import { GuestActions, NavAccount } from './nav-account';
import { NavLink, onProfilePage } from './nav-link';
import { WhoWords } from './who-words';
import { WHO } from '@/lib/who-choices';

function MenuIcon({ path, className }: { path: string; className?: string }) {
  return (
    <svg
      className={className}
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
  const pathname = usePathname();
  const onPro = pathname === '/pro';
  return (
    <Link
      href="/pro"
      aria-current={onPro ? 'page' : undefined}
      onClick={onClick}
      // No prefetch of /pro's script from a profile page (nav-link.tsx).
      {...(onProfilePage(pathname) ? { prefetch: false } : {})}
    >
      Pro
    </Link>
  );
}

export function Navigation({
  businesses,
  claimWords,
  businessStart,
}: {
  /** The Businesses choice's words, rendered on the server per request (BusinessesWho). */
  businesses?: ReactNode;
  /** The signed-out primary action's words ("Get tipped" with business sign-up on). */
  claimWords?: ReactNode;
  /** The header's "For businesses" with business sign-up on. */
  businessStart?: ReactNode;
} = {}) {
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
          <NavLink href="/#how-it-works" onClick={close}>
            How it works
          </NavLink>
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
                {WHO.map((choice) => (
                  <li key={choice.title}>
                    {choice.href ? (
                      <NavLink
                        href={choice.href}
                        className="who__item"
                        data-who-item
                        onClick={close}
                      >
                        <MenuIcon path={choice.icon} className="who__icon" />
                        <div className="who__words">
                          {'flagged' in choice && businesses ? (
                            businesses
                          ) : (
                            <WhoWords title={choice.title} text={choice.text} />
                          )}
                        </div>
                      </NavLink>
                    ) : (
                      <div className="who__item" data-who-item>
                        <MenuIcon path={choice.icon} className="who__icon" />
                        <div className="who__words">
                          <WhoWords
                            title={choice.title}
                            text={choice.text}
                            comingSoon={'comingSoon' in choice}
                          />
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Surface>
          </div>
          <Suspense
            fallback={
              <Link href="/pro" prefetch={false}>
                Pro
              </Link>
            }
          >
            <ProLink onClick={close} />
          </Suspense>
          {/* Sign in and Claim your username, or, signed in, Go to my dashboard (NavAccount). Before
              the address is read it is the signed-out pair, as the server renders it. */}
          <Suspense
            fallback={
              <GuestActions
                onClick={close}
                claimWords={claimWords}
                businessStart={businessStart}
              />
            }
          >
            <NavAccount
              onClick={close}
              claimWords={claimWords}
              businessStart={businessStart}
            />
          </Suspense>
        </nav>
      </Container>
    </header>
  );
}
