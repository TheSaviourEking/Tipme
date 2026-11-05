import { Container } from '@tipme/ui';
import { marketingMetadata } from '@/lib/metadata';
import { BusinessInterestForm } from './business-interest-form';

export const metadata = marketingMetadata(
  'For businesses',
  'TipMe for businesses is on its way. Leave your email and we will tell you when it is ready.',
  '/for-businesses',
);

/** Businesses, built to the PageBusinesses board: interest only, no pricing and no date. */
export default function ForBusinesses() {
  return (
    <main id="main" tabIndex={-1} className="marketing-page">
      <Container>
        <section className="business-hero" aria-labelledby="businesses-title">
          <div>
            <h1 id="businesses-title" className="creators-title">
              TipMe for businesses is on its way.
            </h1>
            <p className="creators-lede business-hero__lede">
              We’re still building it. Leave your email and we’ll tell you when
              it’s ready.
            </p>
          </div>
          <BusinessInterestForm />
        </section>
      </Container>
    </main>
  );
}
