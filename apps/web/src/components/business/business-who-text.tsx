import { WhoWords } from '../who-words';

const TITLE = 'Business';
const TEXT = 'Receive and manage tips for businesses and their employees.';

/** The header's "Business" choice: the same words either way; with business sign-up off it says "Coming soon". */
export function BusinessesWhoText({ on }: { on: boolean }) {
  return <WhoWords title={TITLE} text={TEXT} comingSoon={!on} />;
}

/** The words with no pill: what shows while the flag is being read, so nothing flashes and goes. */
export function BusinessesWhoPending() {
  return <WhoWords title={TITLE} text={TEXT} />;
}
