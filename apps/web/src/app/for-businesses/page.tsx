import { ActionLink, Container } from '@tipme/ui';
import { Arrow } from '@/components/brand';
import { marketingMetadata } from '@/lib/metadata';
import { BusinessInterestForm } from './business-interest-form';

export const metadata = marketingMetadata(
  'For businesses',
  'TipMe for businesses is coming soon.',
  '/for-businesses',
);

export default function ForBusinesses() {
  return (
    <main id="main" tabIndex={-1}>
      <section className="section-space" aria-labelledby="businesses-title">
        <Container>
          <div className="business-page">
            <header className="business-page__intro">
              <span className="eyebrow">Coming soon</span>
              <h1 id="businesses-title" className="page-title">
                Business pages are not open yet.
              </h1>
              <p className="lead-copy">
                TipMe is currently focused on personal pages for people who
                receive tips. Business accounts are not available to create, and
                we have not announced a launch date.
              </p>
              <div className="home-actions">
                <ActionLink href="/sign-up">
                  Create an individual page <Arrow />
                </ActionLink>
              </div>
            </header>
            <BusinessInterestForm />
          </div>
        </Container>
      </section>
    </main>
  );
}
