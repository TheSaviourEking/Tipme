import Link from 'next/link';
import { Container } from '@tipme/ui';
import { Arrow } from '@/components/brand';
import { CreatorArt, HowItWorksSteps } from '@/components/marketing';
import { marketingMetadata } from '@/lib/metadata';

export const metadata = marketingMetadata(
  'For creators',
  'For the creators, teachers and builders who share useful things: one personal link that makes it easy to say thanks.',
  '/for-creators',
);

export default function ForCreators() {
  return (
    <main id="main" tabIndex={-1}>
      <section
        className="use-cases section-space"
        aria-labelledby="creators-title"
      >
        <Container>
          <article className="use-case creator-case">
            <CreatorArt />
            <div className="use-case-copy">
              <span className="eyebrow">For creators</span>
              <h1 id="creators-title" className="page-title">
                For the generous <em>minds.</em>
              </h1>
              <p>
                The tutorial that finally clicked. The template that saved an
                afternoon. When people want to thank you, a personal link makes
                it easy, without a paywall or a subscription.
              </p>
              <p>
                Supporters choose their own amount and can add a few words.
                Nothing is expected, and nothing is hidden.
              </p>
              <Link className="text-link" href="/@ada">
                Meet a demo creator <Arrow diagonal />
              </Link>
            </div>
          </article>
        </Container>
      </section>
      <section
        className="how-section section-space"
        aria-labelledby="creators-how"
      >
        <Container>
          <div className="section-heading">
            <div>
              <p className="eyebrow">How it works</p>
              <h2 id="creators-how">What your supporters see</h2>
            </div>
          </div>
          <HowItWorksSteps />
        </Container>
      </section>
    </main>
  );
}
