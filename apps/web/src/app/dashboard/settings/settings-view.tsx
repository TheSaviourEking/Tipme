'use client';
import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import { DataSection } from './sections/data';
import { GettingPaidSection } from './sections/getting-paid';
import { MyPageSection } from './sections/my-page';
import { NotificationsSection } from './sections/notifications';
import { PlanSection } from './sections/plan';
import { PendingRecovery, SecuritySection } from './sections/security';
import { SETTINGS_SECTIONS, type SettingsSection } from './sections/section';

const isSection = (id: string): id is SettingsSection =>
  SETTINGS_SECTIONS.some((section) => section.id === id);

/**
 * The six section links (ScreenSettings). Each is a plain hash link; with motion welcome the page
 * glides there instead of jumping. The current one follows the hash and, as you read, the scroll.
 */
function SettingsNav() {
  const [current, setCurrent] = useState<SettingsSection>('page');
  useEffect(() => {
    const fromHash = () => {
      const id = location.hash.slice(1);
      if (isSection(id)) setCurrent(id);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    // The sections in the top third of the screen; the last of them is the one being read.
    const inBand = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) inBand.add(entry.target.id);
          else inBand.delete(entry.target.id);
        const reading = SETTINGS_SECTIONS.filter(({ id }) => inBand.has(id));
        const last = reading[reading.length - 1];
        if (last) setCurrent(last.id);
      },
      { rootMargin: '0px 0px -66% 0px' },
    );
    for (const { id } of SETTINGS_SECTIONS) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    return () => {
      window.removeEventListener('hashchange', fromHash);
      observer.disconnect();
    };
  }, []);
  const glide = (event: MouseEvent<HTMLAnchorElement>, id: SettingsSection) => {
    setCurrent(id);
    if (!window.matchMedia('(prefers-reduced-motion: no-preference)').matches)
      return; // The browser's own jump, with no animation.
    const section = document.getElementById(id);
    if (!section) return;
    event.preventDefault();
    history.pushState(null, '', `#${id}`);
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Where the next Tab starts, as the browser's own jump would leave it.
    section.focus({ preventScroll: true });
  };
  return (
    <nav aria-label="Settings" className="settings-nav">
      {SETTINGS_SECTIONS.map(({ id, title }) => (
        <a
          key={id}
          href={`#${id}`}
          aria-current={current === id ? 'location' : undefined}
          onClick={(event) => glide(event, id)}
        >
          {title}
        </a>
      ))}
    </nav>
  );
}

export function SettingsView() {
  // Settings draws itself after the profile loads, after the browser has looked for the anchor:
  // a link to a section (#paid) is followed once the sections exist.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (isSection(id)) document.getElementById(id)?.scrollIntoView();
  }, []);
  return (
    <div className="settings-grid">
      <h1>Settings</h1>
      <PendingRecovery />
      <SettingsNav />
      <div className="settings-chapters">
        <MyPageSection />
        <GettingPaidSection />
        <NotificationsSection />
        <SecuritySection />
        <PlanSection />
        <DataSection />
      </div>
    </div>
  );
}
