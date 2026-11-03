import Link from 'next/link';
import { Container, Surface } from '@tipme/ui';

/**
 * A coming-soon stand-in for a legal page. It deliberately contains no legal terms:
 * entity, jurisdiction and policies are unapproved (docs/00-DECISIONS.md D-02, D-07).
 * Only the layout is designed (ScreenSmall): a readable column on paper. When the approved
 * wording arrives it takes the same column, with its headings as links to each section.
 */
export function LegalPlaceholder({
  title,
}: {
  title: string;
  covers?: string[];
}) {
  return (
    <main id="main" tabIndex={-1} className="legal-page">
      <Container>
        <Surface material="paper" className="legal-page__column">
          <p className="eyebrow">Coming soon</p>
          <h1>{title}</h1>
          <p>
            We are finalising our {title.toLowerCase()} and will publish it
            before TipMe takes real payments. Questions in the meantime? Start
            from <Link href="/#how-it-works">how TipMe works</Link>.
          </p>
        </Surface>
      </Container>
    </main>
  );
}
