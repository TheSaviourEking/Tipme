import type { MyMembership } from '@tipme/contracts';
import type { JSX } from 'react';
import { MyCodeSection } from './sections/my-code';

/**
 * The Work page's sections, one card each per membership (PR B0 registry). Each lane adds its own
 * lines here and nothing else: B3 'invitations', 'where-you-work' · B5 'notes' · B6 'shift'
 * · B7 'share' · B8 'my-code'.
 */
export type WorkSection = {
  id: string;
  title: string;
  Card: (props: { membership: MyMembership }) => JSX.Element;
};

export const WORK_SECTIONS: readonly WorkSection[] = [
  // B8
  { id: 'my-code', title: 'My code', Card: MyCodeSection },
];
