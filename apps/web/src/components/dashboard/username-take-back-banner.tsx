'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { MyProfile } from '@tipme/contracts';
import { Notice } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';
import { freeChangeWords, takeBackBannerWords } from '@/lib/take-back-words';
import { useRecipient } from '@/components/account/recipient-context';

/**
 * The notice that TipMe is taking a username back, or, once it has given the page a new one, that
 * the page can change it once for free. Seeing it can start the notice clock (owner
 * answer 1), so it reports "seen" only while the tab is visible and the banner is on screen: never
 * from a hidden tab's refetch. Once per mount; a hidden tab tries again when it becomes visible.
 * No motion. Notice keeps its system border in forced colours, and the words carry the meaning.
 */
export function UsernameTakeBackBanner() {
  const { profile, setProfile } = useRecipient();
  const takeBack = profile.usernameTakeBack ?? null;
  const box = useRef<HTMLDivElement>(null);
  const reported = useRef<string | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!takeBack || !element) return;
    let onScreen = false;
    const report = () => {
      if (
        reported.current === takeBack.id ||
        !onScreen ||
        document.visibilityState !== 'visible'
      )
        return;
      reported.current = takeBack.id;
      void apiFetch<MyProfile>(
        `/v1/me/handle/take-back/${encodeURIComponent(takeBack.id)}/seen`,
        { method: 'POST' },
      ).then((result) => {
        if (result.ok) setProfile(result.data);
        // A failure may simply be offline: the next visit tries again.
        else reported.current = null;
      });
    };
    const observer = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      report();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', report);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', report);
    };
  }, [takeBack, setProfile]);

  if (!takeBack) {
    const free = profile.usernameFreeChange;
    if (!free) return null;
    const after = freeChangeWords(free);
    return (
      <div className="take-back-banner">
        <Notice title={after.title}>
          <p>
            <Link href="/dashboard/settings#handle">{after.action}</Link>
          </p>
        </Notice>
      </div>
    );
  }
  const words = takeBackBannerWords(takeBack);
  return (
    <div ref={box} className="take-back-banner">
      <Notice title={words.title}>
        <p>{words.why}</p>
        {words.action && (
          <p>
            <Link href="/dashboard/settings#handle">{words.action}</Link>
          </p>
        )}
      </Notice>
    </div>
  );
}
