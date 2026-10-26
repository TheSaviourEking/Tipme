import Image from 'next/image';
import Link from 'next/link';
import { ActionLink, Badge, Container } from '@tipme/ui';
import { AppreciationForm } from '@/components/appreciation-form';
import { Arrow } from '@/components/brand';
import { HowItWorksSteps } from '@/components/marketing';
import { ViewTracker } from '@/components/view-tracker';
import { marketingMetadata } from '@/lib/metadata';

export const metadata = marketingMetadata(
  'TipMe — A little thanks goes a long way',
  'For the people who make your day, your work, your world a little better. Explore TipMe’s non-transactional appreciation preview.',
  '/',
);

const people = [
  {
    handle: 'ada',
    name: 'Ada Okafor',
    photo: '/portraits/ada.webp',
    kicker: 'On the internet',
    title: 'For the generous minds.',
    copy: 'The creators, teachers and builders who put something useful into the world. A personal link makes it easier to say thanks.',
    link: 'Meet a demo creator',
  },
  {
    handle: 'tobi',
    name: 'Tobi Adeyemi',
    photo: '/portraits/tobi.webp',
    kicker: 'Out in the world',
    title: 'For the extra-mile people.',
    copy: 'The familiar faces who make ordinary moments better. A QR code at the counter puts a person behind every little thank you.',
    link: 'Meet a demo professional',
  },
] as const;

export default function Home() {
  return (
    <main id="main" tabIndex={-1} className="home-page">
      <ViewTracker name="landing_viewed" />
      <Container>
        {/* The profile's composition, introduced: a real person, and the instrument to thank them. */}
        <section className="home-hero" aria-labelledby="hero-title">
          <div className="home-hero__scene">
            <div className="home-hero__copy">
              <Badge>Don’t just say thank you,</Badge>
              <h1 id="hero-title" className="home-title">
                Surprise the
                <br />
                people around,
                <br />
                by tipping them.
              </h1>
              <p className="home-lede">
                For the ones who make your day, your work, your world a little
                better. Make sure they know.
              </p>
              <div className="home-actions">
                <ActionLink className="home-primary" href="/sign-up">
                  Create your page <Arrow />
                </ActionLink>
                <Link className="text-link" href="#how-it-works">
                  See how it works
                </Link>
              </div>
              <p className="home-footnote">
                No pressure. No grand gesture. Just a thoughtful way to say “you
                made a difference.”
              </p>
            </div>
            <figure className="home-hero__portrait">
              <Image
                src="/portraits/ada.webp"
                alt="Ada Okafor, a fictional demo recipient"
                width={960}
                height={1200}
                sizes="(max-width: 860px) calc(100vw - 2.5rem), 30vw"
                loading="eager"
                fetchPriority="high"
              />
              <figcaption>
                <strong>Ada Okafor</strong>
                <span>A fictional demo recipient. Go on, try the feeling.</span>
              </figcaption>
            </figure>
          </div>
          <div className="home-hero__panel tip-instrument" id="try-it">
            <AppreciationForm recipient="Ada" handle="ada" collapseExtras />
          </div>
        </section>
      </Container>

      <section className="manifesto">
        <Container>
          <h2>
            Some people give a little extra.
            <br />
            Your thanks can, too.
          </h2>
          <p>
            The tutorial that finally clicked. The coffee made just right. The
            person who went out of their way. This is for them.
          </p>
        </Container>
      </section>

      <section
        className="home-people section-space"
        id="made-for-you"
        aria-labelledby="people-title"
      >
        <Container>
          <div className="section-heading">
            <h2 id="people-title">
              Good people.
              <br />
              Everywhere.
            </h2>
            <p>
              On your screen or around the corner. Appreciation belongs wherever
              care shows up.
            </p>
          </div>
          <div className="home-people__grid">
            {people.map((person) => (
              <article className="person-card" key={person.handle}>
                <div className="person-card__photo">
                  <Image
                    src={person.photo}
                    alt={`${person.name}, a fictional demo recipient`}
                    width={960}
                    height={1200}
                    sizes="(max-width: 860px) calc(100vw - 2.5rem), 40vw"
                  />
                </div>
                <div className="person-card__sheet">
                  <p className="person-card__kicker">{person.kicker}</p>
                  <h3>{person.title}</h3>
                  <p>{person.copy}</p>
                  <Link className="text-link" href={`/@${person.handle}`}>
                    {person.link} <Arrow diagonal />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        </Container>
      </section>

      <section
        className="how-section section-space"
        id="how-it-works"
        aria-labelledby="how-title"
      >
        <Container>
          <div className="section-heading">
            <h2 id="how-title">
              From “that helped”
              <br />
              to “thank you.”
            </h2>
            <p>Three small steps. No account needed to say thanks.</p>
          </div>
          <HowItWorksSteps />
        </Container>
      </section>

      <section
        className="promise-section"
        id="our-promise"
        aria-labelledby="promise-title"
      >
        <Container>
          <div className="promise-grid">
            <div>
              <h2 id="promise-title">
                A warm gesture.
                <br />A clear picture.
              </h2>
              <p>
                Appreciation should feel good on both sides. That starts with
                being honest about what happens next.
              </p>
            </div>
            <ul className="promises">
              <li>
                <h3>Your choice. Always.</h3>
                <p>
                  Choose your own amount. Leave a message, or don’t. No guilt,
                  no nudges disguised as generosity.
                </p>
              </li>
              <li>
                <h3>Clarity before commitment.</h3>
                <p>
                  You see the full cost and what the person receives before you
                  pay. In this preview the fees are illustrative and no money
                  moves.
                </p>
              </li>
              <li>
                <h3>Honest about the outcome.</h3>
                <p>
                  A thank-you only shows as paid once the payment provider
                  confirms it, never on a hopeful screen.
                </p>
              </li>
            </ul>
          </div>
          <div className="closing">
            <h2>A little thanks goes a long way.</h2>
            <div className="home-actions">
              <ActionLink className="home-primary" href="/sign-up">
                Create your page <Arrow />
              </ActionLink>
              <Link className="text-link" href="/@ada">
                See a demo page
              </Link>
            </div>
            <Link href="/about-preview" className="preview-details">
              What’s available in this preview?
            </Link>
          </div>
        </Container>
      </section>
    </main>
  );
}
