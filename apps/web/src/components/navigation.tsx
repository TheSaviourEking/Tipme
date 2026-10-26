'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { ActionLink, Button, Container } from '@tipme/ui';
import { Brand, Arrow } from './brand';

export function Navigation() {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
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
            if (event.key === 'Escape') {
              setOpen(false);
              toggle.current?.focus();
            }
          }}
        >
          <Link href="/how-it-works" onClick={() => setOpen(false)}>
            How it works
          </Link>
          <Link href="/for-creators" onClick={() => setOpen(false)}>
            For creators
          </Link>
          <Link href="/@ada" onClick={() => setOpen(false)}>
            See a demo page
          </Link>
          {/* Guest actions; hidden in the dashboard, where someone already has a page (CSS). */}
          <ActionLink
            className="nav-guest"
            variant="secondary"
            href="/sign-in"
            onClick={() => setOpen(false)}
          >
            Sign in
          </ActionLink>
          {/* Getting someone their own page is the one primary action. */}
          <ActionLink
            className="nav-guest"
            href="/sign-up"
            onClick={() => setOpen(false)}
          >
            Create your page <Arrow />
          </ActionLink>
        </nav>
      </Container>
    </header>
  );
}
