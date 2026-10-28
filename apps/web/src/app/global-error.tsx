'use client';
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import '@tipme/ui/tokens.css';
import '@tipme/ui/components.css';
import './globals.css';
import { Wordmark } from '@/components/brand';

/** When the site's own frame fails, this replaces it entirely: the brand, one sentence, a retry. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="en">
      <body>
        <main id="main" className="quiet-page">
          <div className="quiet-card tm-surface tm-surface--raised">
            <Wordmark className="quiet-card__wordmark" />
            <h1>Something went wrong on our side</h1>
            <div className="quiet-card__body">
              <p>
                TipMe didn’t load. Nothing you did caused it, and nothing was
                charged without your confirmation.
              </p>
            </div>
            <div className="quiet-card__actions">
              <button
                type="button"
                className="tm-button tm-button--primary"
                onClick={reset}
              >
                Try again
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
