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
          Create your own page, share its link or QR code, and send pretend tips
          to any live page, including the fictional demo profiles. Pretend
          payments move no money, and no card is ever charged.
        </p>
        <h2>What happens to what you share</h2>
        <p>
          When you send a pretend tip, its amount and any message or name you
          add are saved with the tip so the person you thanked can see them. If
          you choose to remember your tips on your phone, only a note that you
          tipped is kept in your browser, without amounts or messages. Your
          page’s details are saved to your account on this preview.
        </p>
        <h2>What still needs to be decided</h2>
        <p>
          Launch market and currency, eligibility, fees, payment partners,
          privacy terms and settlement arrangements remain unapproved. NGN in
          the demo is an illustration—not an announced launch currency. There
          are no verified recipients or payout promises, and any “paid” screen
          here confirms a pretend payment only.
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
