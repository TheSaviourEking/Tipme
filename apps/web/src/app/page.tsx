import { ActionLink, Container } from '@tipme/ui';
import { HeaderClaimGate } from '@/components/header-claim-gate';
import { HowLever } from '@/components/how-lever';
import {
  HomeClaim,
  HomeDemo,
  MINIMUM_TIP_TEXT,
  TIPME_SHARE_PERCENT,
  TippedSteps,
  TippingSteps,
} from '@/components/marketing';
import { PaymentModeSlot } from '@/components/payment-mode-slot';
import { ViewTracker } from '@/components/view-tracker';
import { HOME_DESCRIPTION } from '@/lib/payment-mode-copy';
import { marketingMetadata } from '@/lib/metadata';

export const metadata = marketingMetadata(
  'TipMe — A little thanks goes a long way',
  HOME_DESCRIPTION,
  '/',
);

// Built to the ScreenHome board. The headline, the claim field and the example cards are plain
// server HTML: the headline is the largest paint, so it never waits for client JavaScript.
export default function Home() {
  return (
    <main id="main" tabIndex={-1} className="home-page">
      <ViewTracker name="landing_viewed" />
      <HeaderClaimGate />
      <Container>
        <section className="home-hero" aria-labelledby="hero-title">
          <div className="home-hero__copy">
            {/* The owner's wording and capitals (DECISION-LOG, 3 Nov 2026). */}
            <h1 id="hero-title" className="home-title">
              Let People Celebrate You for the things you do.
            </h1>
            <p className="home-lede">
              Your personalized link and QR code to receive global payments
              (USD, EUR, GBP, NGN, Stablecoins), so people can tip you in a few
              taps. They don’t need an account.
            </p>
            <HomeClaim />
            <p className="home-note">
              {/* Whether tipping is open follows the payment mode, not a fixed promise. */}
              <PaymentModeSlot fallback="Free to start.">
                {(_mode, copy) =>
                  ['Free to start.', copy.homeRecipientNotice]
                    .filter(Boolean)
                    .join(' ')
                }
              </PaymentModeSlot>
            </p>
          </div>
          <HomeDemo />
        </section>

        <section
          className="home-how"
          id="how-it-works"
          aria-labelledby="how-title"
        >
          <HowLever tipped={<TippedSteps />} tipping={<TippingSteps />} />
        </section>
      </Container>

      <Container>
        <section className="home-band" aria-labelledby="band-title">
          <div>
            <h2 id="band-title">Appreciation goes a long way.</h2>
            <p>
              TipMe keeps {TIPME_SHARE_PERCENT}% of each tip, and that covers
              processing. You receive the rest, and see every tip and note. The
              smallest tip is {MINIMUM_TIP_TEXT}.
            </p>
          </div>
          <ActionLink variant="secondary" href="/sign-up">
            Claim your username
          </ActionLink>
        </section>
      </Container>
    </main>
  );
}
