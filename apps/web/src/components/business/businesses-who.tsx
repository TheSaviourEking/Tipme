import { BusinessAvailableSlot } from './business-available-slot';

/** The header's "Businesses" choice, in words for each state of the business flag (PR B1). */
export function BusinessesWhoText({ on }: { on: boolean }) {
  return on ? (
    <>
      <strong>Businesses</strong>
      <span>Create your business and let customers thank your team.</span>
    </>
  ) : (
    <>
      <strong>Businesses (coming soon)</strong>
      <span>Tell us you’re interested, and we’ll let you know.</span>
    </>
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
