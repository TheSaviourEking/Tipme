import { LegalPlaceholder } from '@/components/legal-placeholder';
import { getPlanFees } from '@/lib/plan-fees-api';
import {
  TERMS_EXAMPLE_TIP_MINOR,
  TERMS_REFUND_TIP_MINOR,
  termsFeeFigures,
} from '@/lib/terms-fees';
import { previewMetadata } from '@/lib/metadata';
import { WITHDRAWAL_FEE_COPY_MINOR } from '@tipme/domain';
import { Money } from '@/components/money';

export const metadata = previewMetadata(
  'Terms of use',
  'TipMe’s terms of use is coming soon.',
  '/legal/terms',
);

export default async function TermsPlaceholder() {
  // The live rates, the ones new quotes use, and the example nets worked from them by the same pricing.
  const fees = termsFeeFigures(await getPlanFees());
  return (
    <LegalPlaceholder
      title="Terms of use"
      covers={[
        'Who provides the service, and in which countries',
        'How tips, fees, refunds and disputes work',
        'Who is eligible to receive tips, and how payouts happen',
        'Acceptable use and how accounts can be suspended',
        'Liability and how these terms change',
      ]}
    >
      {/* The owner's decisions, 3, 12, 18 and 25 Nov 2026: state the fee here (payment processing
          included, the withdrawal fee shown). The rates and the example nets come from the live setting
          (getPlanFees), so a change in admin shows here; if the API can't be read they are the
          starting rates, Free 5% and Pro 3%. */}
      <section aria-labelledby="fees">
        <h2 id="fees">Fees</h2>
        <p>
          <strong>If you are tipping,</strong> you pay exactly the amount you
          choose. TipMe adds no charge on top. The smallest tip is{' '}
          <span className="money">₦2,000</span>.
        </p>
        <p>
          <strong>If you receive tips,</strong> TipMe keeps {fees.freePercent}%
          of each tip on the Free plan, or {fees.proPercent}% on TipMe Pro,
          unless we have agreed a lower fee with you, and you receive the rest.
          The fee includes the cost of processing the payment. From a{' '}
          <Money minor={Number(TERMS_EXAMPLE_TIP_MINOR)} /> tip, you receive{' '}
          <Money minor={fees.exampleNet.free} /> on Free, or{' '}
          <Money minor={fees.exampleNet.pro} /> on Pro. The fee is set by your
          plan when the supporter sees the amount, so a tip keeps the fee it was
          shown with if your plan changes afterwards.
        </p>
        <p>
          <strong>Withdrawals:</strong> each withdrawal costs{' '}
          <Money minor={Number(WITHDRAWAL_FEE_COPY_MINOR)} />, charged by our
          payment partner, and comes off the amount. The withdraw screen tells
          you before you confirm. The smallest withdrawal is{' '}
          <span className="money">₦2,000</span>, unless you are withdrawing your
          whole balance. Withdrawals from a business’s balance still carry our
          payment partner’s transfer fee, taken from the amount, unless TipMe
          tells the business it pays it.
        </p>
      </section>
      {/* The owner's decisions, 14 Nov 2026: TipMe keeps its fee on a refund (the supporter gets back
          the tip minus it); on a chargeback the recipient gives back only what they received and TipMe
          bears its fee. A product decision, not a regulatory approval (D-05 stays open). */}
      <section aria-labelledby="refunds">
        <h2 id="refunds">Refunds and chargebacks</h2>
        <p>
          <strong>Refunds.</strong> If a tip is refunded, the supporter gets
          back the tip minus TipMe’s fee. TipMe keeps its fee. From a{' '}
          <Money minor={Number(TERMS_REFUND_TIP_MINOR)} /> tip, the supporter
          gets back <Money minor={fees.refundBack.free} /> on Free, or{' '}
          <Money minor={fees.refundBack.pro} /> on Pro, and you give back what
          you received.
        </p>
        <p>
          <strong>Chargebacks.</strong> If the supporter’s bank takes a payment
          back, you give back only what you received from the tip. TipMe bears
          its own fee.
        </p>
        <p>
          At a business, you and the business each give back what you received
          from the tip.
        </p>
      </section>
      {/* The owner's decision, 3 Nov 2026: a username can be taken back, with 7 days of notice. */}
      <section aria-labelledby="usernames">
        <h2 id="usernames">Your username</h2>
        <p>
          Your username is how people find your page. If TipMe needs a username
          back, for example to protect a brand, a public figure or one of our
          own names, we will tell you at least 7 days before we take it, by
          email or on your dashboard when you sign in. We say why and ask you to
          choose a new username. If we cannot reach you either way within 14
          days, we go ahead.
        </p>
        <p>
          Your page, your tips and your balance stay yours under the new
          username. Links and QR codes that use your old username will stop
          working, so update them. If you have not chosen a new username by
          then, we give your page one and tell you by email or on your
          dashboard.
        </p>
        <p>
          We may act sooner, or without notice, if a username impersonates
          someone, infringes a trademark, or the law requires it.
        </p>
      </section>
      {/* Business release 2 (decisions log, 6 Nov 2026). Shown ahead of the feature, which the owner
          turns on only after this text is live. No wording here claims approval by any authority. */}
      <section aria-labelledby="business-shares">
        <h2 id="business-shares">Tips at a business</h2>
        <p>
          <strong>Sharing with the business.</strong> A business you work at on
          TipMe can ask for a share of the tips you receive there. A share
          applies only if you agree to it, and only to tips made after the start
          date you agreed. It never applies to tips through your own page
          outside the business.
        </p>
        <p>
          The share is taken from what you receive after TipMe’s fee. You always
          keep at least half: the business can ask for 10%, 20%, 30% or 50%, and
          nothing else. A change takes effect at least 14 days after the
          business asks, and at most once a month. You can say no, and the
          business is not told that you did. If you leave the business, its
          share ends at once. You can report a business to TipMe at any time.
        </p>
        <p>
          <strong>Tipping the whole team.</strong> A supporter can tip everyone
          on shift at a location. The tip, after TipMe’s fee, is shared equally
          among the people on shift when the tip is made. The business takes no
          share of a team tip.
        </p>
        <p>
          <strong>Refunds and chargebacks.</strong> If a tip is refunded or
          charged back, you and the business each give back what you received
          from it (see Refunds and chargebacks above).
        </p>
      </section>
    </LegalPlaceholder>
  );
}
