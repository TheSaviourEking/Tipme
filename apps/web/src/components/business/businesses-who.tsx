import { WhoWords } from '../who-words';
import { BusinessAvailableSlot } from './business-available-slot';

/** The header's "Business" choice: the same words either way; with business sign-up off it says "Coming soon". */
export function BusinessesWhoText({ on }: { on: boolean }) {
  return (
    <WhoWords
      title="Business"
      text="Receive and manage tips for businesses and their employees."
      comingSoon={!on}
    />
  );
}

/** Read per request; the coming-soon words until it is known. */
export function BusinessesWho() {
  return (
    <BusinessAvailableSlot fallback={<BusinessesWhoText on={false} />}>
      {(on) => <BusinessesWhoText on={on} />}
    </BusinessAvailableSlot>
  );
}
