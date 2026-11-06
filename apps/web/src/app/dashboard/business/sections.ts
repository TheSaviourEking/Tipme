import type { BusinessDetail } from '@tipme/contracts';
import type { JSX } from 'react';
import { OnTodayCard } from './sections/on-today';

/**
 * The Business page's sections (PR B0 registry). Each lane adds its own lines here and nothing
 * else: B1 'details', 'locations', 'managers' · B3 'people' · B6 (inside people, or 'on-today')
 * · B7 'this-week', 'notes' · B8 'codes'.
 */
export type BusinessSection = {
  id: string;
  title: string;
  Card: (props: { business: BusinessDetail }) => JSX.Element;
  /** Shown to owners only. */
  needs?: 'owner';
};

export const BUSINESS_SECTIONS: readonly BusinessSection[] = [
  { id: 'on-today', title: 'On today', Card: OnTodayCard },
];
