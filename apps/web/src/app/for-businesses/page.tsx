import { Container } from '@tipme/ui';
import { BusinessAvailableSlot } from '@/components/business/business-available-slot';
import { marketingMetadata } from '@/lib/metadata';
import { BusinessInterestForm } from './business-interest-form';
import { CreateBusiness } from './create-business';

export const metadata = marketingMetadata(
  'For businesses',
  'TipMe for businesses: customers thank the people who served them, and every tip goes to that person.',
  '/for-businesses',
);

/** While TipMe for businesses is off: interest only, no pricing and no date (PageBusinesses). */
function ComingSoon() {
  return (
    <>
      <div>
        <h1 id="businesses-title" className="creators-title">
          TipMe for businesses is on its way.
        </h1>
        <p className="creators-lede business-hero__lede">
          We’re still building it. Leave your email and we’ll tell you when it’s
          ready.
        </p>
      </div>
      <BusinessInterestForm />
    </>
  );
}

/** On (BUSINESS_ENABLED): an invitation to create a business (owner's answer Q3, 6 Nov 2026). */
function Open() {
  return (
    <>
      <div>
        <h1 id="businesses-title" className="creators-title">
          Let your customers thank your team.
        </h1>
        <p className="creators-lede business-hero__lede">
          Customers scan one code at your place, find the person who served
          them, and thank them with a tip.
        </p>
      </div>
      <CreateBusiness />
    </>
  );
}

/** Businesses, built to the PageBusinesses board. Which version shows is read per request. */
export default function ForBusinesses() {
  return (
    <main id="main" tabIndex={-1} className="marketing-page">
      <Container>
        <section className="business-hero" aria-labelledby="businesses-title">
          <BusinessAvailableSlot fallback={<ComingSoon />}>
            {(on) => (on ? <Open /> : <ComingSoon />)}
          </BusinessAvailableSlot>
        </section>
      </Container>
    </main>
  );
}
