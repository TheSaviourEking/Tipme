import { LegalPlaceholder } from '@/components/legal-placeholder';
import { FEE_POLICY_V2_FREE, FEE_POLICY_V2_PRO, priceTip } from '@tipme/domain';
import { formatNaira } from '@/lib/demo-amount';
import { FREE_SHARE_PERCENT, PRO_SHARE_PERCENT } from '@/lib/fee-share';
import { previewMetadata } from '@/lib/metadata';

// The example in the Fees section, worked out by the same pricing the quotes use.
const EXAMPLE_TIP = BigInt(500000);
const exampleNet = (policy: typeof FEE_POLICY_V2_FREE) =>
  formatNaira(Number(priceTip(EXAMPLE_TIP, policy).recipientNetMinor));

export const metadata = previewMetadata(
  'Terms of use',
  'TipMe’s terms of use is coming soon.',
  '/legal/terms',
);

export default function TermsPlaceholder() {
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
      {/* The owner's decisions, 3 and 12 Nov 2026: state the fee here (Free 7%, Pro 5%). Amounts follow the fee policies. */}
      <section aria-labelledby="fees">
        <h2 id="fees">Fees</h2>
        <p>
          <strong>If you are tipping,</strong> you pay exactly the amount you
          choose. TipMe adds no charge on top. The smallest tip is ₦2,000.
        </p>
        <p>
          <strong>If you receive tips,</strong> TipMe keeps {FREE_SHARE_PERCENT}
          % of each tip on the Free plan, or {PRO_SHARE_PERCENT}% on TipMe Pro,
          unless we have agreed a lower fee with you, and you receive the rest.
          The fee includes the cost of processing the payment. From a{' '}
          {formatNaira(Number(EXAMPLE_TIP))} tip, you receive{' '}
          {exampleNet(FEE_POLICY_V2_FREE)} on Free, or{' '}
          {exampleNet(FEE_POLICY_V2_PRO)} on Pro. The fee is set by your plan
          when the supporter sees the amount, so a tip keeps the fee it was
          shown with if your plan changes afterwards.
        </p>
        <p>
          <strong>Withdrawals:</strong> The smallest withdrawal is ₦2,000,
          unless you are withdrawing your whole balance. Each withdrawal has our
          payment partner’s ₦50 transfer fee, taken from the amount: if you
          withdraw ₦10,000, you receive ₦9,950. A balance of ₦50 or less can’t
          be withdrawn.
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
          charged back, both the staff member’s part and the business’s part are
          taken back, each in proportion to the amount refunded.
        </p>
      </section>
    </LegalPlaceholder>
  );
}
