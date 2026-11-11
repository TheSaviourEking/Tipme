import { LegalPlaceholder } from '@/components/legal-placeholder';
import { previewMetadata } from '@/lib/metadata';

export const metadata = previewMetadata(
  'Privacy notice',
  'TipMe’s privacy notice is coming soon.',
  '/legal/privacy',
);

export default function PrivacyPlaceholder() {
  return (
    <LegalPlaceholder
      title="Privacy notice"
      covers={[
        'Who is responsible for personal data, and how to contact them',
        'What is collected from payers and recipients, including page photos and covers, and why',
        'How long data is kept and how deletion works',
        'Which service providers process data, and where',
        'Recognising a returning supporter, only if they choose it, and how to stop',
        'Anonymous visit counts: what is counted, what is never stored, and how Global Privacy Control or Do Not Track stops it',
      ]}
    >
      {/* Business release 1 (plan B9 Task 24): what a business sees, written before it is turned on. */}
      <section aria-labelledby="business-tipping">
        <h2 id="business-tipping">If you tip at a business</h2>
        <p>
          When you tip someone through a business’s code on TipMe, the tip goes
          to that person, as any tip does. The business sees how many tips each
          person received, the tags and notes supporters chose to leave, and its
          busiest hours. Any count smaller than 3 shows as “Fewer than 3”, so a
          single tip can’t be picked out. A note you leave after paying shows
          with its date only, never the time.
        </p>
        <p>
          The business never sees your name, your contact details, your message
          to the person, the exact time you tipped or your payment reference.
          Your message stays private to the person you tipped. If the person or
          a manager reports a note, the business stops seeing it until TipMe
          reviews it.
        </p>
      </section>
      <section aria-labelledby="business-working">
        <h2 id="business-working">If you work at a business</h2>
        <p>
          Supporters at the business see the name you choose to show and, if you
          choose, your photo. The business sees how many tips you received each
          week, the tags and notes supporters left about you, and whether you
          are on shift. It sees your amounts only if you choose to share them,
          and only in a week with at least 3 tips. You can stop sharing at any
          time.
        </p>
        <p>
          When you leave, your name, your row and the notes about you disappear
          from the business’s view. The business keeps only its location’s
          totals. You can download where you have worked, and the notes written
          about you, from your settings.
        </p>
        <p>
          A business may show its logo on its public pages, beside your name and
          photo; its owners can remove it at any time.
        </p>
      </section>
      {/* Business release 2 (decisions log, 6 Nov 2026): what a share or a team tip shows to whom. */}
      <section aria-labelledby="business-shares">
        <h2 id="business-shares">Tips at a business</h2>
        <p>
          <strong>If you are tipping</strong> someone at a business that takes a
          share of their tips, you are told before you pay how much of what they
          receive goes to the business, and the business is named. If you tip
          the whole team, you are told how many people share it.
        </p>
        <p>
          <strong>If you work at a business,</strong> the business sees whether
          you accepted its share and what that share is. It never learns whether
          you declined: a proposal you said no to looks the same to the business
          as one with no change. A report you make about the business goes to
          TipMe only and is never shown to the business. The business sees the
          total of its share for a week, never the share of a single tip.
        </p>
        <p>
          The business does not see who tipped, their contact details or their
          message, for a shared tip or a team tip.
        </p>
      </section>
    </LegalPlaceholder>
  );
}
