import { redirect } from 'next/navigation';
import { ActionLink, Container } from '@tipme/ui';
import { PaymentModeSlot } from '@/components/payment-mode-slot';
import { previewMetadata } from '@/lib/metadata';
export const metadata = previewMetadata(
  'About TipMe today',
  'What TipMe does today, and what it does not do.',
  '/about-preview',
);
/**
 * Describes a test copy (no real payments, fictional demo). A closed or live copy runs Bachs
 * live, so there it sends visitors home instead of saying it is test money.
 */
export default function AboutPreview() {
  return (
    <PaymentModeSlot>
      {(_mode, copy) =>
        copy.previewPages ? <AboutPreviewText /> : redirect('/')
      }
    </PaymentModeSlot>
  );
}

function AboutPreviewText() {
  return (
    <main id="main" tabIndex={-1}>
      <Container className="prose-page">
        <p className="eyebrow">A note on transparency</p>
        <h1>
          A preview.
          <br />
          <em>Not a promise of payment.</em>
        </h1>
        <p className="lead">
          This is the first expression of TipMe: a more thoughtful way to
          appreciate someone. It is a working design demonstration, not a
          financial service.
        </p>
        <h2>What you can do</h2>
        <p>
          Explore fictional profiles, choose an amount, add a message, and
          review the gesture. No real payment is made, but this working preview
          sends account and demo-tip information to TipMe’s server so those
          features can operate.
        </p>
        <h2>What the preview stores</h2>
        <p>
          If you sign in, your phone number and account details are sent to the
          preview API. Demo tip amounts and messages are also sent to the API
          and stored with the preview data. Do not use real private details or
          sensitive messages here. A draft that has not been submitted remains
          in this page’s memory and is cleared when you leave or refresh.
        </p>
        <h2>What still needs to be decided</h2>
        <p>
          Launch market and currency, eligibility, fees, payment partners,
          privacy terms and settlement arrangements remain unapproved. NGN in
          the demo is an illustration—not an announced launch currency. There
          are no verified recipients or payout promises, and any “paid” screen
          here confirms a test-mode payment only.
        </p>
        <h2>Before anything goes live</h2>
        <p>
          Actual checkout will require approved funds flow, clear fees, secure
          handling, accessibility testing and independently verified outcomes.
          This page is explanatory preview copy, not a final privacy policy or
          legal agreement.
        </p>
        <ActionLink href="/@ada">Back to the demo</ActionLink>
      </Container>
    </main>
  );
}
