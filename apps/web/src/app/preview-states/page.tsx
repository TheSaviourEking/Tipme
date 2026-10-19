import Link from 'next/link';
import {
  ActionLink,
  Card,
  Container,
  EmptyState,
  Notice,
  Skeleton,
} from '@tipme/ui';
import { previewMetadata } from '@/lib/metadata';

export const metadata = previewMetadata(
  'Preview states',
  'Deterministic loading, unavailable and error states for design review.',
  '/preview-states',
);

// Static demonstrations only. Real route states live in app/people/[handle]/{loading,error}.tsx (served at /@handle) and app/not-found.tsx.
export default function PreviewStates() {
  return (
    <main id="main" tabIndex={-1}>
      <Container className="section-space state-demo">
        <p className="eyebrow">Development specimen · Not a product page</p>
        <h1 className="page-title">Interface states.</h1>
        <p>
          Each state is rendered on purpose for review. Nothing is failing and
          nothing is being loaded.
        </p>
        <section aria-labelledby="state-loading">
          <h2 id="state-loading">Loading</h2>
          <Card>
            <Skeleton label="Example: loading profile" />
          </Card>
        </section>
        <section aria-labelledby="state-unavailable">
          <h2 id="state-unavailable">Unavailable</h2>
          <Card>
            <EmptyState
              title="This profile isn’t available."
              action={
                <ActionLink href="/@ada" variant="secondary">
                  Explore a demo profile
                </ActionLink>
              }
            >
              The link may be incorrect, or the page may no longer be here.
            </EmptyState>
          </Card>
        </section>
        <section aria-labelledby="state-error">
          <h2 id="state-error">Recoverable error</h2>
          <Notice tone="error" title="Example: we couldn’t load this profile.">
            No appreciation has been sent. Retry, or return to the home page.
          </Notice>
          <p>
            <Link className="text-link" href="/">
              Back to TipMe
            </Link>
          </p>
        </section>
      </Container>
    </main>
  );
}
