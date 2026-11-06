import type { ReactNode } from 'react';
import { Container, Surface } from '@tipme/ui';
import { Wordmark } from './brand';

/**
 * Every "something's not right" screen (missing page, unavailable profile, failed load), built to
 * the ScreenSmall board: the wordmark, a serif line saying what happened, one plain sentence, the
 * one black way on, and a quiet line under it (a second link, or a reference to quote).
 */
export function QuietScreen({
  title,
  children,
  action,
  foot,
  lead,
}: {
  title: string;
  children: ReactNode;
  /** The one black continuation action. */
  action: ReactNode;
  foot?: ReactNode;
  /** Above the card, inside the page's main region (a manager's note on a business page). */
  lead?: ReactNode;
}) {
  return (
    <main id="main" tabIndex={-1} className="quiet-page">
      <Container>
        {lead}
        <Surface material="instrument" className="quiet-card">
          <Wordmark className="quiet-card__wordmark" />
          <h1>{title}</h1>
          <div className="quiet-card__body">{children}</div>
          <div className="quiet-card__actions">{action}</div>
          {foot && <div className="quiet-card__foot">{foot}</div>}
        </Surface>
      </Container>
    </main>
  );
}
