import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Wordmark } from '@/components/brand';
import { LAGOS_LAUNCH_LABEL, LAGOS_LAUNCH_TARGET } from '@/lib/countdown';
import { parseProductionLaunchAt } from '@/lib/production-launch';
import { Countdown } from './countdown';

export const metadata: Metadata = {
  title: 'A little thanks is almost here',
  description: 'TipMe opens at midnight in Lagos.',
  robots: { index: false, follow: false, nocache: true },
};

export default async function ComingSoonPage() {
  await connection();
  const target =
    parseProductionLaunchAt(process.env.PRODUCTION_LAUNCH_AT) ??
    Date.parse(LAGOS_LAUNCH_TARGET);

  return (
    <main id="main" className="coming-soon-page">
      <section className="coming-soon" aria-labelledby="coming-soon-title">
        <Wordmark className="coming-soon__wordmark" />
        <div className="coming-soon__intro">
          <p className="coming-soon__eyebrow">Coming soon</p>
          <h1 id="coming-soon-title">A little thanks is almost here.</h1>
          <p className="coming-soon__lede">TipMe opens at midnight in Lagos.</p>
        </div>
        <Countdown target={target} />
        <div className="coming-soon__foot">
          <time dateTime={LAGOS_LAUNCH_TARGET}>{LAGOS_LAUNCH_LABEL}</time>
          <p>For the people who make a difference.</p>
        </div>
      </section>
    </main>
  );
}
