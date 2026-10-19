import { LegalPlaceholder } from '@/components/legal-placeholder';
import { previewMetadata } from '@/lib/metadata';

export const metadata = previewMetadata(
  'Privacy notice (placeholder)',
  'Placeholder for TipMe’s privacy notice. Not a legal document.',
  '/legal/privacy',
);

export default function PrivacyPlaceholder() {
  return (
    <LegalPlaceholder
      title="Privacy notice"
      covers={[
        'Who is responsible for personal data, and how to contact them',
        'What is collected from payers and recipients, and why',
        'How long data is kept and how deletion works',
        'Which service providers process data, and where',
        'Consent for analytics, and your rights',
      ]}
    />
  );
}
