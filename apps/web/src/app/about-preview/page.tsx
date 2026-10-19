import { ActionLink, Container } from '@tipme/ui';
import { previewMetadata } from '@/lib/metadata';
export const metadata = previewMetadata(
  'About this preview',
  'What TipMe’s development preview does—and what it does not do.',
  '/about-preview',
);
export default function AboutPreview() {
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
          Explore fictional profiles, choose an illustrative amount, add a
          message, and review the gesture. Nothing is sent, charged or saved to
          an account.
        </p>
        <h2>Your draft stays with you</h2>
        <p>
          Amounts and messages stay in this page’s memory. We do not send them
          to an API, write them to browser storage, or include them in a share
          link. Refreshing or leaving the page clears the draft.
        </p>
        <h2>What still needs to be decided</h2>
        <p>
          Launch market and currency, eligibility, fees, payment partners,
          privacy terms and settlement arrangements remain unapproved. NGN in
          the demo is an illustration—not an announced launch currency. There
          are no verified recipients, payout promises or payment-success screens
          here.
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
