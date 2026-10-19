'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationView } from '@tipme/contracts';
import { Button } from '@tipme/ui';
import { apiFetch } from '@/lib/session-client';

const POLL_MS = 10_000;

/**
 * The bell and the "You got a tip" toast. Polls for unread notifications while the page is
 * visible; a notification seen for the first time after the page opened pops up once.
 */
export function NotificationBell() {
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
        <span aria-hidden="true">🔔</span>
        {unread.length > 0 && (
          <span className="bell__count" aria-hidden="true">
            {unread.length}
          </span>
        )}
      </Button>
      {open && (
        <div id="notification-list" className="bell__panel">
          <h2>Notifications</h2>
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
