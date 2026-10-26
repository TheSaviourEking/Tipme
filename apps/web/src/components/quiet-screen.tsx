import type { ReactNode } from 'react';
import { Container, Surface } from '@tipme/ui';

/**
 * Every "something's not right" screen (missing page, unavailable profile, failed load): one
 * calm card that says what happened in plain words and offers a way forward.
 */
export function QuietScreen({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <main id="main" tabIndex={-1} className="quiet-page">
      <Container>
        <Surface material="raised" className="quiet-card">
          <span className="quiet-card__mark" aria-hidden="true">
            ✳
          </span>
          <h1>{title}</h1>
          <div className="quiet-card__body">{children}</div>
          <div className="quiet-card__actions">{actions}</div>
        </Surface>
      </Container>
    </main>
  );
}
