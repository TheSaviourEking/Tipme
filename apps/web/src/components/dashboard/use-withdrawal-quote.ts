'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LiveEventType,
  WithdrawalQuoteLocalResponse,
  WithdrawalQuoteResponse,
} from '@tipme/contracts';
import { useLiveEvents } from '@/components/live/live-provider';
import { mergeLocalQuote } from '@/lib/quote-merge';
import { apiFetch } from '@/lib/session-client';
import { usePanel, type PanelError } from './use-panel';

const PATH = '/v1/me/withdrawal-quote';

export interface WithdrawalQuotePanel {
  data: WithdrawalQuoteResponse | null;
  error: PanelError;
  /** A live change that only a full quote can size: the page asks the person to check. */
  needsCheck: boolean;
  /** The full quote, which asks the payment partner: only for a person's own action. */
  reload: () => Promise<void>;
}

/**
 * The withdrawal quote on Home and Withdraw. The full quote asks the payment partner, so it is read
 * once per visit and again only when the person acts (withdraws, taps "Check again"). A live signal
 * reads `?scope=local`, TipMe's records alone, and never makes a partner call (quote-merge.ts).
 */
export function useWithdrawalQuote(
  live: readonly LiveEventType[],
): WithdrawalQuotePanel {
  const full = usePanel<WithdrawalQuoteResponse>(PATH, { resync: false });
  const [local, setLocal] = useState<ReturnType<typeof mergeLocalQuote> | null>(
    null,
  );
  // The newest read, full or local, decides; an older answer never replaces a newer one.
  const latest = useRef(0);
  const shown = useRef<WithdrawalQuoteResponse | null>(null);
  const showing = local ? local.quote : full.data;
  useEffect(() => {
    shown.current = showing;
  });

  const readLocal = useCallback(async () => {
    const mine = ++latest.current;
    const result = await apiFetch<WithdrawalQuoteLocalResponse>(
      `${PATH}?scope=local`,
    );
    // A failed read keeps what is shown.
    if (mine !== latest.current || !result.ok) return;
    setLocal(mergeLocalQuote(shown.current, result.data));
  }, []);
  useLiveEvents(live, readLocal, { resync: false });

  const { reload: reloadFull } = full;
  const reload = useCallback(async () => {
    const mine = ++latest.current;
    await reloadFull();
    if (mine === latest.current) setLocal(null);
  }, [reloadFull]);

  return local
    ? { data: local.quote, error: null, needsCheck: local.needsCheck, reload }
    : { data: full.data, error: full.error, needsCheck: false, reload };
}
