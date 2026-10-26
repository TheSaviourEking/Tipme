'use client';

import { useEffect, useRef, useState } from 'react';
import {
  countdownAnnouncement,
  countdownParts,
  launchMinuteBucket,
  type CountdownParts,
} from '@/lib/countdown';

const units: ReadonlyArray<{
  key: Exclude<keyof CountdownParts, 'complete'>;
  label: string;
}> = [
  { key: 'days', label: 'Days' },
  { key: 'hours', label: 'Hours' },
  { key: 'minutes', label: 'Minutes' },
  { key: 'seconds', label: 'Seconds' },
];

export function Countdown({ target }: { target: number }) {
  const [now, setNow] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('Countdown loading.');
  const announcedBucket = useRef<number | null>(null);
  const reloading = useRef(false);

  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const parts = now === null ? null : countdownParts(target, now);
  const bucket = now === null ? null : launchMinuteBucket(target, now);

  useEffect(() => {
    if (!parts || bucket === null || bucket === announcedBucket.current) return;
    announcedBucket.current = bucket;
    setAnnouncement(countdownAnnouncement(parts));
  }, [bucket, parts]);

  useEffect(() => {
    if (!parts?.complete || reloading.current) return;
    reloading.current = true;
    window.location.reload();
  }, [parts?.complete]);

  return (
    <div className="launch-countdown">
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <div className="launch-countdown__grid" aria-hidden="true">
        {units.map(({ key, label }) => (
          <div
            className={`launch-countdown__tile launch-countdown__tile--${key}`}
            key={key}
          >
            <span className="launch-countdown__value">
              {parts ? String(parts[key]).padStart(2, '0') : '––'}
            </span>
            <span className="launch-countdown__label">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
