import type { BusinessDetail } from '@tipme/contracts';
import type { JSX } from 'react';
import { DetailsCard } from './sections/details';
import { LocationsCard } from './sections/locations';
import { ManagersCard } from './sections/managers';
import { PeopleCard } from './sections/people';

/**
 * The Business page's sections (PR B0 registry). Each lane adds its own lines here and nothing
 * else: B1 'details', 'locations', 'managers' · B3 'people' · B6 (inside people, or 'on-today')
 * · B7 'this-week', 'notes' · B8 'codes'.
 */
export type BusinessSection = {
  id: string;
  title: string;
  /**
   * `onChange` hands the page a business a write answered with (PR B1), so every section and the
   * page's heading show it at once.
   */
  Card: (props: {
    business: BusinessDetail;
    onChange?: (next: BusinessDetail) => void;
  }) => JSX.Element;
  /** Shown to owners only. */
  needs?: 'owner';
};

export const BUSINESS_SECTIONS: readonly BusinessSection[] = [
  { id: 'details', title: 'Details', Card: DetailsCard },
  { id: 'locations', title: 'Locations', Card: LocationsCard },
  { id: 'managers', title: 'Managers', Card: ManagersCard },
  { id: 'people', title: 'People', Card: PeopleCard },
];
