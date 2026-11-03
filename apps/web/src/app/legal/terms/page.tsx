import { LegalPlaceholder } from '@/components/legal-placeholder';
import { previewMetadata } from '@/lib/metadata';

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
      {/* The owner's decision, 3 Nov 2026: state the fee here. Amounts follow FEE_POLICY_V1. */}
      <section aria-labelledby="fees">
        <h2 id="fees">Fees</h2>
        <p>
          <strong>If you are tipping,</strong> you pay exactly the amount you
          choose. TipMe adds no charge on top. The smallest tip is ₦2,000.
        </p>
        <p>
          <strong>If you receive tips,</strong> TipMe keeps 10% of each tip,
          unless we have agreed a different fee with you, and you receive the
          rest. The 10% includes the cost of processing the payment. From a
          ₦5,000 tip, you receive ₦4,500.
        </p>
        <p>
          <strong>Withdrawals:</strong> The smallest withdrawal is ₦2,000,
          unless you are withdrawing your whole balance. TipMe does not charge
          you to withdraw.
        </p>
      </section>
      {/* The owner's decision, 3 Nov 2026: a username can be taken back, with 7 days of notice. */}
      <section aria-labelledby="usernames">
        <h2 id="usernames">Your username</h2>
        <p>
          Your username is how people find your page. If TipMe needs a username
          back, for example to protect a brand, a public figure or one of our
          own names, we will email you at least 7 days before we take it. The
          email says why and asks you to choose a new username.
        </p>
        <p>
          Your page, your tips and your balance stay yours under the new
          username. Links and QR codes that use your old username will stop
          working, so update them. If you have not chosen a new username by
          then, we give your page one and email it to you.
        </p>
        <p>
          We may act sooner, or without notice, if a username impersonates
          someone, infringes a trademark, or the law requires it.
        </p>
      </section>
    </LegalPlaceholder>
  );
}
