'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
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

export function Navigation() {
  const [open, setOpen] = useState(false);
  const [whoOpen, setWhoOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const who = useRef<HTMLButtonElement>(null);
  const whoGroup = useRef<HTMLDivElement>(null);

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

  return (
    <header className="site-header">
      <Container className="nav-shell">
        <Brand />
        <Button
          className="menu-toggle"
          variant="secondary"
          ref={toggle}
          aria-expanded={open}
          aria-controls="site-navigation"
          onClick={() => setOpen(!open)}
        >
          Menu
        </Button>
        <nav
          id="site-navigation"
          aria-label="Main navigation"
          className={`site-nav ${open ? 'is-open' : ''}`}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // Focus goes back to the control that was opened, whichever one is on screen.
            const popover = whoOpen && who.current?.offsetParent != null;
            close();
            (popover ? who : toggle).current?.focus();
          }}
        >
          <Link href="/how-it-works" onClick={close}>
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
