'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationView } from '@tipme/contracts';
import { Button } from '@tipme/ui';
import { RECOVERY_EMAIL_CHANGED } from '@/lib/owner-attention';
import { apiFetch } from '@/lib/session-client';
import type { RecoveryEmailStatus } from '@tipme/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const POLL_MS = 10_000;

/**
 * The bell and the "You got a tip" toast. Polls for unread notifications while the page is
 * visible; a notification seen for the first time after the page opened pops up once.
 */
export function NotificationBell() {
  const pathname = usePathname();
  const [needsRecoveryEmail, setNeedsRecoveryEmail] = useState(false);
  useEffect(() => {
    const refresh = () =>
      void apiFetch<RecoveryEmailStatus>('/v1/me/recovery-email').then(
        (result) => setNeedsRecoveryEmail(result.ok && !result.data.confirmed),
      );
    refresh();
    window.addEventListener(RECOVERY_EMAIL_CHANGED, refresh);
    return () => window.removeEventListener(RECOVERY_EMAIL_CHANGED, refresh);
  }, [pathname]);
  const [unread, setUnread] = useState<NotificationView[]>([]);
  const [all, setAll] = useState<NotificationView[] | null>(null);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<NotificationView | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const button = useRef<HTMLButtonElement>(null);

  const poll = useCallback(async () => {
    const result = await apiFetch<NotificationView[]>(
      '/v1/me/notifications?unreadOnly=1',
    );
    if (!result.ok) return;
    setUnread(result.data);
    if (seen.current === null) {
      seen.current = new Set(result.data.map((n) => n.id));
      return;
    }
    // A new tip is what the recipient most wants to hear about; then any other news.
    const unseen = result.data.filter((n) => !seen.current?.has(n.id));
    const fresh = unseen.find((n) => n.kind === 'tip') ?? unseen[0];
    for (const n of result.data) seen.current.add(n.id);
    if (fresh) setToast(fresh);
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void poll(), 0);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void poll();
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [poll]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(timer);
  }, [toast]);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    const result = await apiFetch<NotificationView[]>('/v1/me/notifications');
    if (result.ok) setAll(result.data);
    if (unread.length > 0) {
      await apiFetch('/v1/me/notifications/read', {
        method: 'POST',
        body: { ids: unread.map((n) => n.id) },
      });
      setUnread([]);
    }
  };

  const label = `Notifications, ${unread.length === 0 ? 'none' : unread.length} unread`;
  return (
    <div
      className="bell"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <Button
        ref={button}
        variant="quiet"
        aria-label={label}
        aria-expanded={open}
        aria-controls="notification-list"
        onClick={() => void toggle()}
      >
        {/* An authored icon; the button's accessible name carries the meaning. */}
        <svg
          className="bell__icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15z" />
          <path d="M10 20.5a2 2 0 0 0 4 0" />
        </svg>
        {unread.length > 0 && (
          <span className="bell__count" aria-hidden="true">
            {unread.length}
          </span>
        )}
      </Button>
      {open && (
        <div id="notification-list" className="bell__panel">
          <h2>Notifications</h2>
          {needsRecoveryEmail && (
            <p className="tm-hint">
              <Link href="/dashboard/settings#recovery">
                Add a recovery email
              </Link>{' '}
              so you can get back in if you lose access to your email.
            </p>
          )}
          {all === null ? (
            <p>Loading…</p>
          ) : all.length === 0 ? (
            <p>Nothing yet.</p>
          ) : (
            <ul>
              {all.map((n) => (
                <li key={n.id}>
                  <strong>{n.title}</strong>
                  <span>{n.body}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div role="status" className="toast-region">
        {toast && (
          <div className="toast">
            <strong>{toast.title}</strong> · {toast.body}
          </div>
        )}
      </div>
    </div>
  );
}
