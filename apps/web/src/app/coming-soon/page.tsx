import type { Metadata } from 'next';
import { connection } from 'next/server';
import { HEART_MARK, Wordmark } from '@/components/brand';
import { LAGOS_LAUNCH_TARGET, launchIso, launchLabel } from '@/lib/countdown';
import { siteOrigin } from '@/lib/metadata';
import { parseProductionLaunchAt } from '@/lib/production-launch';
import { Countdown } from './countdown';

export const metadata: Metadata = {
  title: 'A little thanks is almost here',
  description: 'TipMe opens at midnight in Lagos.',
  robots: { index: false, follow: false, nocache: true },
};

// The launch instant is request-time state; do not prerender this route as an instant page.
export const instant = false;

export default async function ComingSoonPage() {
  await connection();
  const target =
    parseProductionLaunchAt(process.env.PRODUCTION_LAUNCH_AT) ??
    Date.parse(LAGOS_LAUNCH_TARGET);

  return (
    <main id="main" className="coming-soon-page">
      <section className="coming-soon" aria-labelledby="coming-soon-title">
        <Wordmark className="coming-soon__wordmark" />
        <div className="coming-soon__stage">
          <div className="coming-soon__intro">
            <p className="coming-soon__eyebrow">Coming soon</p>
            <h1 id="coming-soon-title">A little thanks is almost here.</h1>
            <p className="coming-soon__lede">
              TipMe opens at midnight in Lagos.
            </p>
          </div>
          {/* Decoration: a page like the ones that are coming. Hidden from screen readers. */}
          <div className="coming-soon__card" aria-hidden="true">
            <div className="coming-soon__card-cover" />
            <div className="coming-soon__card-avatar">
              <svg viewBox={HEART_MARK.viewBox} width="26" height="26">
                <path d={HEART_MARK.d} transform={HEART_MARK.transform} />
              </svg>
            </div>
            <p className="coming-soon__card-title">Your page</p>
            <p className="coming-soon__card-link">
              {siteOrigin.host}/@yourname
            </p>
            <p className="coming-soon__card-key">Tip</p>
          </div>
        </div>
        <Countdown target={target} />
        <div className="coming-soon__foot">
          <time dateTime={launchIso(target)}>{launchLabel(target)}</time>
          <p>For the people who make a difference.</p>
        </div>
      </section>
    </main>
  );
}
