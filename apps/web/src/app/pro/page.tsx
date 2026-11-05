import { Container } from '@tipme/ui';
import { PlanPreview } from '@/components/marketing/plan-preview';
import { marketingMetadata } from '@/lib/metadata';

export const metadata = marketingMetadata(
  'Pro',
  'TipMe Pro: more QR designs, three handle changes, your own tip amounts, up to 8 links with one featured, and no TipMe link on your page. Ask us for Pro.',
  '/pro',
);

/**
 * Pro and pricing, built to the PagePro board. Pro is granted by staff with a written reason and
 * has no price until the owner sets one (docs/00-DECISIONS.md), so this page never names one.
 */
export default function ProPage() {
  return (
    <main id="main" tabIndex={-1} className="pro-page">
      <Container>
        <PlanPreview />
      </Container>
    </main>
  );
}
