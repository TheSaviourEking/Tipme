import Link from 'next/link';
import { ActionLink, Container } from '@tipme/ui';
import { Arrow } from '@/components/brand';
import { HowItWorksSteps } from '@/components/marketing';
import { marketingMetadata } from '@/lib/metadata';

export const metadata = marketingMetadata(
  'How it works',
  'How TipMe turns “that helped” into a thank you: find your person, make it yours, see the thought behind it.',
  '/how-it-works',
);

export default function HowItWorks() {
  return (
    <main id="main" tabIndex={-1}>
      <section
        className="how-section section-space"
        aria-labelledby="how-title"
      >
        <Container>
          <div className="section-heading">
            <div>
              <p className="eyebrow">The idea is simple</p>
              <h1 id="how-title" className="page-title">
                How TipMe <em>works.</em>
              </h1>
            </div>
          </div>
          <p className="lead-copy">
            From “that helped” to “thank you” in three small steps. No account
            needed to say thanks.
          </p>
          <HowItWorksSteps />
          <div className="page-actions">
            <ActionLink href="/@ada">
              Try it with a demo profile <Arrow />
            </ActionLink>
            <Link className="text-link" href="/about-preview">
              What this preview can and cannot do
            </Link>
          </div>
        </Container>
      </section>
    </main>
  );
}
