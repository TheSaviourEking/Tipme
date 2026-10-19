'use client';
import { useEffect, useState } from 'react';
import type { MomentView } from '@tipme/contracts';
import { Button } from '@tipme/ui';
import { track } from '@/lib/analytics';
import { apiFetch } from '@/lib/session-client';

const FOURTEEN_DAYS = 14 * 86_400_000;

/** Recent moments. Each is private until shared; a shared one shows on the page for 14 days. */
export function Moments() {
  const [moments, setMoments] = useState<
    (MomentView & { onPage: boolean })[] | null
  >(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    void apiFetch<MomentView[]>('/v1/me/moments').then((result) => {
      if (!result.ok) return;
      const now = Date.now();
      setMoments(
        result.data.slice(0, 5).map((moment) => ({
          ...moment,
          onPage:
            moment.sharedAt !== null &&
            now - Date.parse(moment.sharedAt) < FOURTEEN_DAYS,
        })),
      );
    });
  }, [round]);
  if (!moments || moments.length === 0) return null;
  const share = async (id: string) => {
    await apiFetch(`/v1/me/moments/${id}/share`, { method: 'POST', body: {} });
    track('moment_shared', { surface: 'moments' });
    setRound((n) => n + 1);
  };
  return (
    <section aria-labelledby="moments-title" className="moments">
      <h2 id="moments-title">Moments</h2>
      <ul className="moment-list">
        {moments.map((moment) => {
          return (
            <li key={moment.id}>
              <p>
                <span aria-hidden="true">✳ </span>
                {moment.title}
              </p>
              {moment.onPage ? (
                <span className="tm-hint">Shared on your page</span>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => void share(moment.id)}
                >
                  Share on my page
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="tm-hint">
        Sharing shows the moment on your page, never what you were given.
      </p>
    </section>
  );
}
