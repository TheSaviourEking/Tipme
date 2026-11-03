/** Marketing pieces shared by the home page and the PRD marketing routes. */
import Image from 'next/image';
import type { ReactNode } from 'react';
import { FEE_POLICY_V1, STANDARD_TIP_PRESETS_MINOR } from '@tipme/domain';
import { Button } from '@tipme/ui';
import { formatNaira } from '@/lib/demo-amount';
import { AdaCard, PersonCard } from './demo-cards';
import { IndigoQr } from './marketing/indigo-qr';
import { ModeText } from './payment-mode-slot';

/** The three steps of a tip, in order. */
export function HowItWorksSteps() {
  return (
    <ol className="steps">
      <li>
        <span>01</span>
        <h3>Find your person.</h3>
        <p>
          Open their personal link. Recognize the face, the work, the care that
          brought you here.
        </p>
      </li>
      <li>
        <span>02</span>
        <h3>Make it yours.</h3>
        <p>
          Choose a gesture that feels right. Add a few words if you’d like. No
          pressure, always your choice.
        </p>
      </li>
      <li>
        <span>03</span>
        <h3>See the thought behind it.</h3>
        <p>
          <ModeText pick="howItWorksPay" />
        </p>
      </li>
    </ol>
  );
}

/* ---- Home (ScreenHome board) ---------------------------------------------------------------
   Everything below renders on the server. The only client island on Home is the steps lever
   (how-lever.tsx), so the headline and the claim field never wait for client JavaScript. */

/** TipMe's share as a whole percentage, from the fee policy. */
export const TIPME_SHARE_PERCENT = Number(FEE_POLICY_V1.tipmeShareBps) / 100;
const naira = (minor: bigint) => formatNaira(Number(minor));
// The three standard amounts; the middle one is shown chosen in the pictures.
const [SMALL_TIP, DEFAULT_TIP, LARGE_TIP] = STANDARD_TIP_PRESETS_MINOR;

/** The smallest tip, from the fee policy, for the sentence that states it. */
export const MINIMUM_TIP_TEXT = naira(FEE_POLICY_V1.minTipMinor);

/** The claim field: a plain GET form, so it works before (and without) JavaScript. */
export function HomeClaim() {
  return (
    <form
      className="home-claim"
      action="/sign-up"
      method="get"
      aria-label="Claim your link"
    >
      <label className="tm-well home-claim__field">
        <span className="home-claim__prefix">usetipme.xyz/@</span>
        <input
          name="handle"
          aria-label="Your handle"
          placeholder="yourname"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={30}
          pattern="[A-Za-z0-9_]{3,30}"
          title="3 to 30 letters, numbers or underscores. Capitals become lowercase."
        />
      </label>
      <Button type="submit" variant="continue" className="home-claim__go">
        Claim your username
      </Button>
    </form>
  );
}

function AmountKeys({ dark = false }: { dark?: boolean }) {
  return (
    <div className="home-keys" data-tone={dark ? 'dark' : undefined}>
      {STANDARD_TIP_PRESETS_MINOR.map((amount) => (
        <span
          key={String(amount)}
          className="home-key"
          data-selected={amount === DEFAULT_TIP ? 'true' : undefined}
        >
          {naira(amount)}
        </span>
      ))}
    </div>
  );
}

function Heart({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path d="M12 21s-7.5-4.6-9.6-9.3C1 8.4 3 5 6.4 5c2.2 0 4 1.2 5.6 3.4C13.6 6.2 15.4 5 17.6 5 21 5 23 8.4 21.6 11.7 19.5 16.4 12 21 12 21z" />
    </svg>
  );
}

const TIP_LABEL = naira(DEFAULT_TIP);

/**
 * Three example pages, as a picture of what TipMe makes. The stack is hidden from assistive
 * technology and holds nothing focusable; the caption says in words that the people are examples.
 * On a narrow screen only the front card shows, as on the phone board. On a wide screen with a
 * fine pointer the cards drift, turn over to a note when clicked, and Ada's Tip says thank you
 * (demo-cards.tsx): small client islands, and the headline never waits for them.
 */
export function HomeDemo() {
  return (
    <div className="home-demo">
      <div className="home-demo__stack" aria-hidden="true">
        <PersonCard
          className="home-demo__card home-demo__card--zainab"
          name="Zainab"
          note="Thank you for hanging out in chat. You make every stream better."
          front={
            <>
              <div className="home-demo__cover home-demo__cover--ocean">
                <Heart className="home-demo__cover-heart" />
              </div>
              <div className="home-demo__body">
                <span className="home-demo__avatar home-demo__avatar--initial">
                  Z
                </span>
                <p className="home-demo__name">Zainab</p>
                <p className="home-demo__role">Streamer</p>
                <span className="home-demo__tip">Tip Zainab</span>
              </div>
            </>
          }
        />
        <PersonCard
          className="home-demo__card home-demo__card--tobi"
          name="Tobi"
          note="Thanks for dancing to my set all night. See you at the next one!"
          front={
            <>
              <div className="home-demo__cover">
                <Image
                  src="/covers/waveform.webp"
                  alt=""
                  fill
                  sizes="280px"
                  className="home-demo__img"
                />
              </div>
              <div className="home-demo__body">
                <span className="home-demo__avatar">
                  <Image
                    src="/portraits/tobi.webp"
                    alt=""
                    width={76}
                    height={76}
                    sizes="76px"
                    className="home-demo__img"
                  />
                </span>
                <p className="home-demo__name">Tobi</p>
                <p className="home-demo__role">DJ and producer</p>
                <span className="home-demo__tip">Tip Tobi</span>
              </div>
            </>
          }
        />
        <AdaCard
          amounts={STANDARD_TIP_PRESETS_MINOR.map(naira)}
          initial={STANDARD_TIP_PRESETS_MINOR.indexOf(DEFAULT_TIP)}
          note="Thank you for watching my edits. It means a lot to me."
          cover={
            <Image
              src="/covers/sunburst.webp"
              alt=""
              fill
              sizes="(max-width: 75rem) 90vw, 320px"
              className="home-demo__img"
            />
          }
          avatar={
            <Image
              src="/portraits/ada.webp"
              alt=""
              width={92}
              height={92}
              sizes="92px"
              className="home-demo__img"
            />
          }
        />
        <IndigoQr className="home-demo__qr" sizes="164px" />
      </div>
      <p className="home-demo__caption">Examples, not real people.</p>
    </div>
  );
}

function Step({
  title,
  children,
  media,
  tone,
}: {
  title: string;
  children: string;
  media: ReactNode;
  /** The picture's ground: a photo, a lilac wash, a recessed well or the signature purple. */
  tone: 'photo' | 'soft' | 'well' | 'signature';
}) {
  return (
    <li className="home-step">
      <div className="home-step__media" data-tone={tone} aria-hidden="true">
        {media}
      </div>
      <div className="home-step__body">
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </li>
  );
}

/** What a recipient does, in three steps. */
export function TippedSteps() {
  return (
    <ol className="home-steps" aria-label="Steps if you get tipped">
      <Step
        title="Make it yours"
        tone="photo"
        media={
          <>
            <Image
              src="/covers/confetti.webp"
              alt=""
              fill
              sizes="(max-width: 48rem) 90vw, 380px"
              className="home-demo__img"
            />
            <span className="home-step__avatar">
              <Image
                src="/portraits/ada.webp"
                alt=""
                width={64}
                height={64}
                sizes="64px"
                className="home-demo__img"
              />
            </span>
          </>
        }
      >
        Claim your link, add your face, choose your cover.
      </Step>
      <Step
        title="Share it anywhere"
        tone="soft"
        media={<IndigoQr className="home-step__qr" sizes="120px" />}
      >
        Put your QR on the counter, or your link in your bio.
      </Step>
      <Step
        title="Get your thanks"
        tone="well"
        media={
          <ul className="home-step__tips">
            {[LARGE_TIP, DEFAULT_TIP, SMALL_TIP].map((amount) => (
              <li key={String(amount)}>
                <Heart />
                {naira(amount)}
              </li>
            ))}
          </ul>
        }
      >
        See every tip and note, then withdraw to your bank.
      </Step>
    </ol>
  );
}

/** What a supporter does, in three steps. */
export function TippingSteps() {
  return (
    <ol className="home-steps" aria-label="Steps if you're tipping">
      <Step
        title="Scan or tap"
        tone="soft"
        media={<IndigoQr className="home-step__qr" sizes="120px" />}
      >
        Scan their QR code or open their link. No app, no account.
      </Step>
      <Step
        title="Choose an amount"
        tone="well"
        media={
          <div className="home-step__keys">
            <AmountKeys dark />
            <span className="home-demo__tip">Tip {TIP_LABEL}</span>
          </div>
        }
      >
        Add a note if you like. You pay exactly the amount you choose.
      </Step>
      <Step
        title="Say your thanks"
        tone="signature"
        media={<Heart className="home-step__heart" />}
      >
        Confirm on our payment partner’s page. They get your tip and your note.
      </Step>
    </ol>
  );
}
