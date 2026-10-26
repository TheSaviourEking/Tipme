import type { ReactNode } from 'react';
import { Container, Surface } from '@tipme/ui';

/** Sign-up and sign-in: an editorial welcome beside one floating card, like the public profile. */
export function AuthStage({
  title,
  lede,
  promises,
  children,
}: {
  title: string;
  lede: string;
  /** Short, true reassurances shown beside the form. */
  promises?: readonly string[];
  children: ReactNode;
}) {
  return (
    <main id="main" tabIndex={-1} className="auth-page">
      <Container className="auth-stage">
        <div className="auth-intro">
          <h1 className="auth-title">{title}</h1>
          <p className="auth-lede">{lede}</p>
          {promises && (
            <ul className="auth-promises">
              {promises.map((promise) => (
                <li key={promise}>{promise}</li>
              ))}
            </ul>
          )}
        </div>
        <Surface material="raised" className="auth-card">
          {children}
        </Surface>
      </Container>
    </main>
  );
}

/** Where someone is in a short flow; the current step is announced as such. */
export function AuthProgress({
  label,
  steps,
  current,
}: {
  label: string;
  steps: readonly string[];
  current: number;
}) {
  return (
    <ol className="auth-progress" aria-label={label}>
      {steps.map((step, index) => (
        <li
          key={step}
          className={
            index < current ? 'is-done' : index === current ? 'is-current' : ''
          }
          aria-current={index === current ? 'step' : undefined}
        >
          {step}
        </li>
      ))}
    </ol>
  );
}
