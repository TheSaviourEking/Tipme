import Image from 'next/image';
import Link from 'next/link';
import { ActionLink, Container } from '@tipme/ui';
import { Arrow } from '@/components/brand';
import { HowItWorksSteps } from '@/components/marketing';
import { marketingMetadata } from '@/lib/metadata';

export const metadata = marketingMetadata(
  'For individuals',
  'For the creators, teachers and builders who share useful things: one personal link that makes it easy to say thanks.',
  '/for-creators',
);

export default function ForCreators() {
  return (
    <main id="main" tabIndex={-1}>
      <section className="section-space" aria-labelledby="creators-title">
        <Container>
          {/* A real person beside the promise, as on the home page. */}
          <article className="creator-hero">
            <div className="person-card__photo">
              <Image
                src="/portraits/ada.webp"
                alt="Ada Okafor, a fictional demo creator"
                width={960}
                height={1200}
                sizes="(max-width: 860px) calc(100vw - 2.5rem), 40vw"
                loading="eager"
                fetchPriority="high"
              />
            </div>
            <div className="use-case-copy">
              <span className="eyebrow">For individuals</span>
              <h1 id="creators-title" className="page-title">
                For the generous minds.
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
              <div className="home-actions">
                <ActionLink className="home-primary" href="/sign-up">
                  Create your page <Arrow />
                </ActionLink>
                <Link className="text-link" href="/@ada">
                  Meet a demo creator <Arrow diagonal />
                </Link>
              </div>
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
