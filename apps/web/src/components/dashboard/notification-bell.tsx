'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NOTIFICATION_PREFS_CHANGED,
  type NotificationPrefsView,
  type NotificationView,
} from '@tipme/contracts';
import { Button } from '@tipme/ui';
import {
  useFirstReadPhase,
  useKeepStreamOpenWhenHidden,
  useLiveEvents,
  useLiveStatus,
} from '@/components/live/live-provider';
import { RECOVERY_EMAIL_CHANGED } from '@/lib/owner-attention';
import { apiFetch } from '@/lib/session-client';
import {
  createFirstRead,
  FIRST_READ_CAP_MS,
  type FirstRead,
} from '@/lib/first-read';
import {
  createPopupPrefsLoader,
  POPUP_PREFS_UNKNOWN,
  type PopupPrefs,
} from '@/lib/popup-prefs';
import { announce, type AnnouncerState } from '@/lib/tip-announcement';
import { createTipSound, type TipSound } from '@/lib/tip-sound';
import type { RecoveryEmailStatus } from '@tipme/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const POLL_MS = 10_000;
const TOAST_MS = 8000;
const MINUTE_MS = 60_000;

/**
 * The one loader for the bell's notifications: the unread list, an error and reload(). It reads
 * again on `notifications.changed` (and every live resync or fallback poll); its own 10 s poll runs
 * only where there is no live stream (turned off, or no provider). Notifications first seen after
 * the page opened are handed to `onFresh` once. This is the only place a new tip is announced.
 */
function useNotifications(onFresh: (fresh: NotificationView[]) => void) {
  const [unread, setUnread] = useState<NotificationView[]>([]);
  const [error, setError] = useState<'load' | 'refresh' | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const loaded = useRef(false);
  const fresh = useRef(onFresh);
  useEffect(() => {
    fresh.current = onFresh;
  });

  const first = useRef<FirstRead | null>(null);
  const reload = useCallback(async () => {
    first.current?.started();
    const result = await apiFetch<NotificationView[]>(
      '/v1/me/notifications?unreadOnly=1',
    );
    if (!result.ok) {
      // A failed refresh keeps the last list; the bell itself stays quiet about it.
      setError(loaded.current ? 'refresh' : 'load');
      return;
    }
    loaded.current = true;
    setError(null);
    setUnread(result.data);
    if (seen.current === null) {
      seen.current = new Set(result.data.map((n) => n.id));
      return;
    }
    const unseen = result.data.filter((n) => !seen.current?.has(n.id));
    for (const n of result.data) seen.current.add(n.id);
    if (unseen.length > 0) fresh.current(unseen);
  }, []);

  useLiveEvents(NOTIFICATIONS_CHANGED, reload);
  const status = useLiveStatus();
  const ownPoll = status === 'idle' || status === 'disabled';
  // One read on load: while the stream connects, its ready resync is the first (first-read.ts).
  useEffect(() => {
    const controller = createFirstRead({
      capMs: FIRST_READ_CAP_MS,
      read: () => void reload(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (timer) => window.clearTimeout(timer as number),
    });
    first.current = controller;
    return () => controller.dispose();
  }, [reload]);
  const phase = useFirstReadPhase();
  useEffect(() => {
    first.current?.update(phase);
  }, [phase, reload]);
  useEffect(() => {
    if (!ownPoll) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [reload, ownPoll]);
  return { data: unread, setData: setUnread, error, reload };
}

const NOTIFICATIONS_CHANGED = ['notifications.changed'] as const;
const NO_SIGNALS = [] as const;
const ACCOUNT_CHANGED = ['account.changed'] as const;

/**
 * The pop-up switches, read on mount and whenever Settings saves them (same tab). Hidden details
 * and no sound until they have loaded, and if they can't be (popup-prefs.ts).
 */
function usePopupPrefs(): PopupPrefs {
  const [prefs, setPrefs] = useState<PopupPrefs>(POPUP_PREFS_UNKNOWN);
  const [loader] = useState(() =>
    createPopupPrefsLoader({
      read: () =>
        apiFetch<NotificationPrefsView>('/v1/me/notification-preferences'),
      onPrefs: setPrefs,
    }),
  );
  useEffect(() => {
    const read = () => void loader.load();
    read();
    window.addEventListener(NOTIFICATION_PREFS_CHANGED, read);
    return () => window.removeEventListener(NOTIFICATION_PREFS_CHANGED, read);
  }, [loader]);
  // A failed read is tried again on the next ready (or other resync): only then does it ask.
  useLiveEvents(NO_SIGNALS, () => loader.retryIfFailed());
  // Saved on another tab or device (live updates): read them again.
  useLiveEvents(ACCOUNT_CHANGED, () => loader.load(), { resync: false });
  return prefs;
}

/** The bell and the "You got a tip" toast. */
export function NotificationBell() {
  const pathname = usePathname();
  const [needsRecoveryEmail, setNeedsRecoveryEmail] = useState(false);
  // The recovery email changed on another tab or device: its reminder is read again.
  const [accountRound, setAccountRound] = useState(0);
  useLiveEvents(ACCOUNT_CHANGED, async () => setAccountRound((n) => n + 1), {
    resync: false,
  });
  useEffect(() => {
    const refresh = () =>
      void apiFetch<RecoveryEmailStatus>('/v1/me/recovery-email').then(
        (result) => setNeedsRecoveryEmail(result.ok && !result.data.confirmed),
      );
    refresh();
    window.addEventListener(RECOVERY_EMAIL_CHANGED, refresh);
    return () => window.removeEventListener(RECOVERY_EMAIL_CHANGED, refresh);
  }, [pathname, accountRound]);
  const [all, setAll] = useState<NotificationView[] | null>(null);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const prefs = usePopupPrefs();
  const prefsNow = useRef(prefs);
  useEffect(() => {
    prefsNow.current = prefs;
  });
  const announcer = useRef<AnnouncerState>({ lastAt: null, heldCount: 0 });
  // Made once the page is in a browser; it arms itself on the first click or key press.
  const sound = useRef<TipSound | null>(null);
  useEffect(() => {
    if (typeof Audio === 'function')
      sound.current ??= createTipSound({
        src: '/sounds/new-tip.wav',
        volume: 0.35,
        Audio,
        document,
      });
  }, []);
  // A hidden tab keeps its stream while the sound could play (plan note 3).
  useKeepStreamOpenWhenHidden(
    () => Boolean(sound.current?.armed) && prefsNow.current.tipSound,
  );
  const [flushAt, setFlushAt] = useState<number | null>(null);
  const speak = useCallback((fresh: NotificationView[]) => {
    const result = announce(announcer.current, fresh, Date.now(), {
      hideDetails: prefsNow.current.hideTipDetailsInPopups,
    });
    announcer.current = result.state;
    if (result.text) setToast(result.text);
    // Tips held inside the minute are counted out when it ends.
    setFlushAt(
      result.state.heldCount > 0 && result.state.lastAt !== null
        ? result.state.lastAt + MINUTE_MS
        : null,
    );
  }, []);
  const onFresh = useCallback(
    (fresh: NotificationView[]) => {
      speak(fresh);
      // Tip notifications are written only for paid tips (notifyTipSucceeded): once per arrival.
      if (fresh.some((n) => n.kind === 'tip'))
        sound.current?.play({
          enabled: prefsNow.current.tipSound,
          isPaidTip: true,
        });
    },
    [speak],
  );
  const { data: unread, setData: setUnread } = useNotifications(onFresh);

  useEffect(() => {
    if (flushAt === null) return;
    const timer = setTimeout(
      () => speak([]),
      Math.max(0, flushAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [flushAt, speak]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
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
        // Focusable because a long list scrolls inside it, and keyboards must be able to scroll.
        <div id="notification-list" className="bell__panel" tabIndex={0}>
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
                  {n.kind === 'business_invitation' && (
                    <Link href="/dashboard/work">See the invitation</Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div role="status" className="toast-region">
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  );
}
