import type { ReactNode } from 'react';

/** The six parts of Settings (ScreenSettings), in order. Each id is the hash that reaches it. */
export const SETTINGS_SECTIONS = [
  { id: 'page', title: 'My page' },
  { id: 'paid', title: 'Getting paid' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'security', title: 'Sign-in and security' },
  { id: 'plan', title: 'Plan' },
  { id: 'data', title: 'Your data and page' },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];

const titleOf = (id: SettingsSection) =>
  SETTINGS_SECTIONS.find((section) => section.id === id)!.title;

/** One section: its editorial title, then its parts, separated by hairlines rather than cards. */
export function SettingsChapter({
  id,
  className,
  children,
}: {
  id: SettingsSection;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      // Focusable, so a link that glides here can leave the next Tab starting from it.
      tabIndex={-1}
      className={`settings-chapter${className ? ` ${className}` : ''}`}
    >
      <h2 id={`${id}-title`} className="settings-chapter__title">
        {titleOf(id)}
      </h2>
      {children}
    </section>
  );
}
