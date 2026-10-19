import Link from 'next/link';
import { ActionLink, Badge, Container } from '@tipme/ui';
import { AppreciationForm } from '@/components/appreciation-form';
import { Avatar } from '@/components/avatar';
import { Arrow } from '@/components/brand';
import { CreatorArt, HowItWorksSteps } from '@/components/marketing';
import { previewMetadata } from '@/lib/metadata';

export const metadata = previewMetadata(
  'TipMe — A little thanks goes a long way',
  'For the people who make your day, your work, your world a little better. Explore TipMe’s non-transactional appreciation preview.',
  '/',
);
export default function Home() {
  return (
    <main id="main" tabIndex={-1}>
      <Container>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <Badge>
              <span className="badge-dot" /> Don&apos;t just say thank you,
            </Badge>
            <h1 id="hero-title">
              Surprise the
              <br />
              people around,
              <br />
              <em>by tipping them.</em>
            </h1>
            <p className="hero-description">
              For the ones who make your day, your work,
              <br className="desktop-break" /> your world a little better. Make
              sure they know.
            </p>
            <div className="hero-actions">
              <ActionLink href="/@ada">
                Try a little appreciation <Arrow />
              </ActionLink>
              <a className="text-link" href="#how-it-works">
                See how it works <span aria-hidden="true">↘</span>
              </a>
            </div>
            <div className="hero-footnote">
              <span className="tiny-star" aria-hidden="true">
                ✳
              </span>
              <span>
                No pressure. No grand gesture.
                <br />
                Just a thoughtful way to say, “you made a difference.”
              </span>
            </div>
          </div>
          <div className="hero-demo" id="try-it">
            <span className="demo-orbit" aria-hidden="true" />
            <div className="demo-person">
              <Avatar src="/illustrations/ada.svg" name="Ada" size={52} />
              <div>
                <strong>Ada Okafor</strong>
                <span>Designer. Maker. Day-improver.</span>
              </div>
              <span className="person-flower" aria-hidden="true">
                ✳
              </span>
            </div>
            <AppreciationForm recipient="Ada" handle="ada" compact />
            <div className="demo-caption">
              <span aria-hidden="true">↖</span> Go on. Try the feeling.
              <small>Fictional profile · Nothing is sent</small>
            </div>
          </div>
        </section>
      </Container>
      <section className="manifesto">
        <Container>
          <p className="eyebrow">Small gesture. Real meaning.</p>
          <h2>
            Some people give a little extra.
            <br />
            Your thanks can, <em>too.</em>
          </h2>
          <p>
            The tutorial that finally clicked. The coffee made just right.
            <br className="desktop-break" /> The person who went out of their
            way. This is for them.
          </p>
        </Container>
      </section>
      <section className="use-cases section-space" id="made-for-you">
        <Container>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Made for everyday difference-makers</p>
              <h2>
                Good people.
                <br />
                <em>Everywhere.</em>
              </h2>
            </div>
            <p>
              On your screen or around the corner.
              <br />
              Appreciation belongs wherever care shows up.
            </p>
          </div>
          <div className="use-case-grid">
            <article className="use-case creator-case">
              <CreatorArt />
              <div className="use-case-copy">
                <span className="eyebrow">01 / On the internet</span>
                <h3>For the generous minds.</h3>
                <p>
                  The creators, teachers, and builders who put something useful
                  into the world. A personal link makes it easier to say thanks.
                </p>
                <Link className="text-link" href="/@ada">
                  Meet a demo creator <Arrow diagonal />
                </Link>
              </div>
            </article>
            <article className="use-case service-case">
              <div className="service-art" aria-hidden="true">
                <div className="cup">
                  <span>tipme ✳</span>
                </div>
                <div className="care-ticket">
                  <span>THE LITTLE THINGS</span>
                  <strong>
                    Remembered
                    <br />
                    your usual.
                  </strong>
                  <div className="ticket-divider" />
                  <p>
                    One small moment.
                    <br />A better kind of morning.
                  </p>
                  <span className="ticket-star">✳</span>
                </div>
              </div>
              <div className="use-case-copy">
                <span className="eyebrow">02 / Out in the world</span>
                <h3>For the extra-mile people.</h3>
                <p>
                  The familiar faces who make ordinary moments better. A shared
                  profile can put a person behind every little thank you.
                </p>
                <Link className="text-link" href="/@tobi">
                  Meet a demo professional <Arrow diagonal />
                </Link>
              </div>
            </article>
          </div>
        </Container>
      </section>
      <section className="how-section section-space" id="how-it-works">
        <Container>
          <div className="section-heading">
            <div>
              <p className="eyebrow">The idea is simple</p>
              <h2>
                From “that helped”
                <br />
                to <em>“thank you.”</em>
              </h2>
            </div>
            <Badge>Explore the concept</Badge>
          </div>
          <HowItWorksSteps />
        </Container>
      </section>
      <section className="promise-section" id="our-promise">
        <Container>
          <div className="promise-grid">
            <div>
              <p className="eyebrow">Thoughtful by design</p>
              <h2>
                A warm gesture.
                <br />
                <em>A clear picture.</em>
              </h2>
              <p>
                Appreciation should feel good on both sides.
                <br />
                That starts with being honest about what happens next.
              </p>
            </div>
            <ul className="promises">
              <li>
                <span aria-hidden="true">↗</span>
                <div>
                  <h3>Your choice. Always.</h3>
                  <p>
                    Choose your own amount. Leave a message, or don’t. No guilt,
                    no nudges disguised as generosity.
                  </p>
                </div>
              </li>
              <li>
                <span aria-hidden="true">↗</span>
                <div>
                  <h3>Clarity before commitment.</h3>
                  <p>
                    Future checkout must show the full cost before you pay. This
                    preview does not calculate fees or collect funds.
                  </p>
                </div>
              </li>
              <li>
                <span aria-hidden="true">↗</span>
                <div>
                  <h3>Honest about the outcome.</h3>
                  <p>
                    A preview is only a preview. A real thank-you payment will
                    need verified confirmation, never a hopeful screen.
                  </p>
                </div>
              </li>
            </ul>
          </div>
          <div className="closing">
            <span className="closing-flower" aria-hidden="true">
              ✳
            </span>
            <h2>
              A little thanks.
              <br />
              <em>A long way.</em>
            </h2>
            <ActionLink href="/@ada">
              Explore a demo profile <Arrow />
            </ActionLink>
            <Link href="/about-preview" className="preview-details">
              What’s available in this preview?
            </Link>
          </div>
        </Container>
      </section>
    </main>
  );
}
