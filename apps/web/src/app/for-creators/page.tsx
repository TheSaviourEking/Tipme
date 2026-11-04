import { FEE_POLICY_V1 } from '@tipme/domain';
import { ActionLink, Container } from '@tipme/ui';
import { WhereYouMeetPeople } from '@/components/marketing/where-you-meet-people';
import { TIPME_SHARE_PERCENT } from '@/components/marketing';
import { formatNaira } from '@/lib/demo-amount';
import { marketingMetadata } from '@/lib/metadata';

export const metadata = marketingMetadata(
  'For individuals',
  'For barbers, drivers, streamers and creators: one personal link or QR code that makes it easy for people to say thanks.',
  '/for-creators',
);

const MIN_WITHDRAWAL = formatNaira(Number(FEE_POLICY_V1.minWithdrawalMinor));

/** Individuals, built to the PageCreators board. The page is server HTML; only the demo is a client island. */
export default function ForCreators() {
  return (
    <main id="main" tabIndex={-1}>
      <Container>
        <section className="creators-hero" aria-labelledby="creators-title">
          <div>
            <h1 id="creators-title" className="creators-title">
              People already want to thank you.
            </h1>
            <p className="creators-lede">
              Barbers, drivers, streamers, creators: put your link in your bio
              or your QR code on the counter. People tip in a few taps, without
              an account, and you read every note.
            </p>
            <ActionLink
              variant="continue"
              href="/sign-up"
              className="creators-claim"
            >
              Claim your username
            </ActionLink>
          </div>
          <WhereYouMeetPeople />
        </section>
        <section
          className="creators-uses"
          aria-labelledby="creators-uses-title"
        >
          <h2 id="creators-uses-title">Made for how you already show up.</h2>
          <div className="creators-uses__grid">
            <p>
              <strong>If you work with people,</strong> keep a printed QR on
              your counter, mirror or car seat, or send your link after a job
              well done. <strong>If you stream,</strong> show your QR on screen
              and pin your link, so viewers can tip you while you’re live.
            </p>
            <p className="creators-uses__quiet">
              <strong>If you post,</strong> one link goes in your bio and
              captions. <strong>If you hit a milestone,</strong> share it on
              your page and people can add to the celebration.
            </p>
          </div>
        </section>
        <section
          className="creators-band"
          aria-labelledby="creators-band-title"
        >
          <div>
            <h2 id="creators-band-title">Your name, your page.</h2>
            <p>
              Free to start. TipMe keeps {TIPME_SHARE_PERCENT}% of each tip,
              processing included, and you withdraw to your bank from{' '}
              {MIN_WITHDRAWAL}, or take your whole balance if it is less.
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
