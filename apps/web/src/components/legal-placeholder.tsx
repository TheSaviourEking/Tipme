import Link from 'next/link';
import type { ReactNode } from 'react';
import { Container, Surface } from '@tipme/ui';

/**
 * A coming-soon stand-in for a legal page. Entity, jurisdiction and policies are unapproved
 * (docs/00-DECISIONS.md D-02, D-07), so only what the owner has settled is published in it.
 * The layout is designed (ScreenSmall): a readable column on paper. When the approved wording
 * arrives it takes the same column, with its headings as links to each section.
 */
export function LegalPlaceholder({
  title,
  children,
}: {
  title: string;
  covers?: string[];
  /** Parts already settled and published ahead of the rest, such as how fees work. */
  children?: ReactNode;
}) {
  return (
    <main id="main" tabIndex={-1} className="legal-page">
      <Container>
        <Surface material="paper" className="legal-page__column">
          <p className="eyebrow">Coming soon</p>
          <h1>{title}</h1>
          <p>
            We are finalising our full {title.toLowerCase()} and will publish it
            here. Questions in the meantime? Start from{' '}
            <Link href="/#how-it-works">how TipMe works</Link>.
          </p>
          {children}
        </Surface>
      </Container>
    </main>
  );
}
