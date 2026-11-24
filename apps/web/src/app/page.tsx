import { ActionLink, Container } from '@tipme/ui';
import { HeaderClaimGate } from '@/components/header-claim-gate';
import { HowLever } from '@/components/how-lever';
import {
  HomeClaim,
  HomeDemo,
  MINIMUM_TIP_TEXT,
  TippedSteps,
  TippingSteps,
} from '@/components/marketing';
import { PaymentModeSlot } from '@/components/payment-mode-slot';
import { PlanFeePercent } from '@/components/plan-fee-percent';
import {
  GetTippedWords,
  ReleaseFlagsSlot,
} from '@/components/release-flags-slot';
import Link from 'next/link';
import { ViewTracker } from '@/components/view-tracker';
import { HOME_DESCRIPTION, SITE_DESCRIPTION } from '@/lib/payment-mode-copy';
import { marketingMetadata, siteOrigin } from '@/lib/metadata';
import { homeStructuredData, serializeJsonLd } from '@/lib/structured-data';

export const metadata = marketingMetadata(
  'TipMe — A little tip goes a long way',
  HOME_DESCRIPTION,
  '/',
);

// Server-rendered once. The CSP already allows inline scripts, and a ld+json block never runs,
// so it needs no nonce. Update it when the giving product launches.
const homeJsonLd = serializeJsonLd(
  homeStructuredData({
    origin: siteOrigin.origin,
    logoPath: '/icons/192.png',
    siteDescription: SITE_DESCRIPTION,
    homeDescription: HOME_DESCRIPTION,
  }),
);

// Built to the ScreenHome board. The headline, the claim field and the example cards are plain
// server HTML: the headline is the largest paint, so it never waits for client JavaScript.
export default function Home() {
  return (
    <main id="main" tabIndex={-1} className="home-page marketing-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: homeJsonLd }}
      />
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
            {/* Business sign-up (owner, 14 Nov 2026): one quiet line to the business path. */}
            <ReleaseFlagsSlot>
              {(flags) =>
                flags.businessSignup && (
                  <p className="home-business-line">
                    Signing up a business? Get one QR code for each place, and
                    tips reach your staff.{' '}
                    <Link href="/sign-up?for=business">
                      Start with your business
                      <span aria-hidden="true"> →</span>
                    </Link>
                  </p>
                )
              }
            </ReleaseFlagsSlot>
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
              TipMe keeps <PlanFeePercent plan="free" />% of each tip on Free,
              or <PlanFeePercent plan="pro" />% on Pro, and that covers payment
              and withdrawal fees. You receive the rest, and see every tip and
              note. The smallest tip is{' '}
              <span className="money">{MINIMUM_TIP_TEXT}</span>.
            </p>
          </div>
          <ActionLink variant="secondary" href="/sign-up">
            <GetTippedWords />
          </ActionLink>
        </section>
      </Container>
    </main>
  );
}
