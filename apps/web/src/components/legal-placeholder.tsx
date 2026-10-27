import Link from 'next/link';
import { Container } from '@tipme/ui';

/**
 * A coming-soon stand-in for a legal page. It deliberately contains no legal terms:
 * entity, jurisdiction and policies are unapproved (docs/00-DECISIONS.md D-02, D-07).
 */
export function LegalPlaceholder({
  title,
}: {
  title: string;
  covers?: string[];
}) {
  return (
    <main id="main" tabIndex={-1}>
      <Container className="prose-page">
        <p className="eyebrow">Coming soon</p>
        <h1>{title}</h1>
        <p>
          We are finalising our {title.toLowerCase()} and will publish it before
          TipMe takes real payments. Questions in the meantime? Start from{' '}
          <Link href="/how-it-works">how TipMe works</Link>.
        </p>
      </Container>
    </main>
  );
}
