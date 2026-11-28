import { Inject, Injectable } from '@nestjs/common';
import type { TipStatusState } from '@tipme/contracts';
import {
  claimReceiptCheck,
  reconcileAttempts,
  tipStatusView,
} from '@tipme/database';
import type { BachsProvider } from '@tipme/payments';
import { DatabaseProvider } from '../infra/database.js';
import { BACHS_PROVIDER_TOKEN } from './payment-provider.provider.js';

/** The receipt polls every second at first; Bachs is asked at most this often per tip. */
const RECEIPT_CHECK_GAP_MS = 4_000;
const MINUTE = 60_000;

/** A receipt stops following its tip once it reads one of these. */
export const FINAL_TIP_STATES: ReadonlySet<TipStatusState> = new Set([
  'paid',
  'declined',
  'cancelled',
]);

/**
 * While a receipt's stream is open, how long until its copy asks Bachs again (addendum §3.6): as
 * often as a polling receipt would (`claimReceiptCheck` still bounds it to one check per 4 s per
 * tip across every copy and tab), every 15 s after two minutes, and never past the stream's 15.
 */
export function receiptStreamCheckDelay(elapsedMs: number): number | null {
  if (elapsedMs < 2 * MINUTE) return 4_000;
  if (elapsedMs < 15 * MINUTE) return 15_000;
  return null;
}

/**
 * Runs `check` on receiptStreamCheckDelay's schedule until it says the tip is final (then
 * `onFinal`, once), the schedule ends, or `stop`. One check at a time; a check that throws only
 * waits for the next. Framework-free, so the schedule is unit-tested (receipt-check.test.mjs).
 */
export function scheduleReceiptChecks(o: {
  /** True when the tip is final after this check. */
  check(): Promise<boolean>;
  onFinal(): void;
  onError?(error: unknown): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}): { stop(): void } {
  const started = o.now();
  let stopped = false;
  let timer: unknown;
  const arm = () => {
    const delay = receiptStreamCheckDelay(o.now() - started);
    if (stopped || delay === null) return;
    timer = o.setTimer(() => {
      timer = undefined;
      void o.check().then(
        (final) => {
          if (stopped) return;
          if (final) {
            stopped = true;
            o.onFinal();
            return;
          }
          arm();
        },
        (error: unknown) => {
          o.onError?.(error);
          arm();
        },
      );
    }, delay);
  };
  arm();
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) o.clearTimer(timer);
      timer = undefined;
    },
  };
}

/**
 * A supporter is watching this tip's receipt: read the payment from Bachs now, with the worker's
 * own checks, instead of waiting for a webhook or the worker's next round. Used by every status
 * read and, while a receipt's stream is open, by the copy holding it. A failed read changes
 * nothing; the receipt keeps waiting and the worker keeps checking.
 */
@Injectable()
export class ReceiptCheckService {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(BACHS_PROVIDER_TOKEN)
    private readonly bachs: Pick<
      BachsProvider,
      'verifyTransaction' | 'environment'
    > | null,
  ) {}

  /** Only with Bachs configured, as today: with the mock, webhooks are the only news. */
  get enabled(): boolean {
    return this.bachs !== null;
  }

  /** True when this call asked Bachs (no other copy or tab had in the last 4 s). */
  async check(tipId: string): Promise<boolean> {
    if (!this.bachs) return false;
    const now = new Date();
    const attemptId = await claimReceiptCheck(this.database.db, {
      tipId,
      provider: 'bachs',
      now,
      minGapMs: RECEIPT_CHECK_GAP_MS,
    });
    if (!attemptId) return false;
    const bachs = this.bachs;
    await reconcileAttempts({
      db: this.database.db,
      provider: {
        environment: bachs.environment,
        verifyTransaction: (reference, expectation) =>
          bachs.verifyTransaction(reference, expectation),
      },
      now,
      minAgeMs: 0,
      attemptId,
    });
    return true;
  }

  /** The tip's receipt state, as the status route reads it; null for an unknown tip. */
  async state(tipId: string): Promise<TipStatusState | null> {
    const view = await tipStatusView(this.database.db, tipId, new Date());
    return view?.state ?? null;
  }
}
