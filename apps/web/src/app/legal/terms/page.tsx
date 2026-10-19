import { LegalPlaceholder } from '@/components/legal-placeholder';
import { previewMetadata } from '@/lib/metadata';

export const metadata = previewMetadata(
  'Terms of use (placeholder)',
  'Placeholder for TipMe’s terms of use. Not a legal document.',
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
    />
  );
}
