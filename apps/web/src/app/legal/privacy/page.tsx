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
        'Consent for analytics, and your rights',
      ]}
    >
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
