import { BusinessAvailableSlot } from './business-available-slot';
import { BusinessesWhoPending, BusinessesWhoText } from './business-who-text';

/** Read per request; the words without a pill until it is known (no flash of "Coming soon"). */
export function BusinessesWho() {
  return (
    <BusinessAvailableSlot fallback={<BusinessesWhoPending />}>
      {(on) => <BusinessesWhoText on={on} />}
    </BusinessAvailableSlot>
  );
}
