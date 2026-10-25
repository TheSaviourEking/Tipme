import Link from 'next/link';
import { Container, Notice } from '@tipme/ui';

/**
 * Clearly labelled stand-in for a legal page. It deliberately contains no legal terms:
 * entity, jurisdiction and policies are unapproved (docs/00-DECISIONS.md D-02, D-07).
 */
export function LegalPlaceholder({
  title,
  covers,
}: {
  title: string;
  covers: string[];
}) {
  return (
    <main id="main" tabIndex={-1}>
      <Container className="prose-page">
        <p className="eyebrow">Placeholder — not a legal document</p>
        <h1>{title}</h1>
        <Notice title="Placeholder — not a legal document">
          TipMe’s {title.toLowerCase()} has not been written or approved yet.
          Nothing on this page is an agreement, a policy or advice, and no terms
          apply to this preview.
        </Notice>
        <h2>What the final version will need to cover</h2>
        <ul>
          {covers.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <h2>Until then</h2>
        <p>
          This preview does not process real payments. If you use its sign-in or
          demo-tip features, account and demo-tip information is sent to and
          stored by the preview service. Do not submit sensitive information.{' '}
          <Link href="/about-preview">Read about this preview</Link>.
        </p>
      </Container>
    </main>
  );
}
