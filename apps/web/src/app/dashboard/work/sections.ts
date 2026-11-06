import type { MyMembership } from '@tipme/contracts';
import type { JSX } from 'react';
import { WhereYouWorkCard } from './sections/where-you-work';

/**
 * The Work page's sections, one card each per membership (PR B0 registry). Each lane adds its own
 * lines here and nothing else: B3 'invitations', 'where-you-work' · B5 'notes' · B6 'shift'
 * · B7 'share' · B8 'my-code'. B3's invitations are not per membership, so the page draws them
 * above the workplaces (`sections/invitations.tsx`).
 */
export type WorkSection = {
  id: string;
  title: string;
  Card: (props: { membership: MyMembership }) => JSX.Element;
};

export const WORK_SECTIONS: readonly WorkSection[] = [
  { id: 'where-you-work', title: 'How you show here', Card: WhereYouWorkCard },
];
