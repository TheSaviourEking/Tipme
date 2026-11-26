import type {
  CollectStatusView,
  WithdrawalQuoteResponse,
  WithdrawalRequestResult,
  WithdrawalRow,
} from '@tipme/contracts';
import {
  COLLECT_COPY,
  COLLECT_HELD_NOTE,
  COLLECT_WITHDRAW_WORDS,
  FIRST_WITHDRAWAL_COPY,
  WITHDRAW_SPLIT_COPY,
} from '@tipme/contracts/copy';
import {
  belowWithdrawalMinimum,
  withdrawalMinimumMinor,
  withdrawalPartCount,
} from '@tipme/domain';
import type { LampTone } from '@tipme/ui';
import { formatNaira } from './demo-amount.ts';

const SETTINGS = '/dashboard/settings';

/** A notice beside a usable form: part of the balance can't go now (spec §6). */
export interface ExtraNotice {
  title: string;
  body: string;
  href?: string;
  linkLabel?: string;
}

export interface WithdrawState {
  /**
   * `held_elsewhere`: the person's money is only where withdrawals can't reach it, and the quote
   * isn't ready. A ready quote is never blocked by money held elsewhere (spec §6): it says so in
   * `extraNotices` instead.
   */
  kind: WithdrawalQuoteResponse['state'] | 'held_elsewhere' | 'needs_check';
  canWithdraw: boolean;
  /** Keep the form in view, disabled: the balance is fine, only the check is not. */
  showForm: boolean;
  notice: {
    title: string;
    body: string;
    tone: 'neutral' | 'error';
    href?: string;
    linkLabel?: string;
  };
  /** Our payment partner is checking a withdrawal already under way. */
  review: string | null;
  /**
   * Where the notice's words go (WithdrawRedesign): on the instrument (one line, no box), in a
   * slip, or a standing warning.
   */
  place: 'instrument' | 'slip' | 'warning';
  /** The ink stamp on the slip, when there is one. */
  stamp?: string;
  /** Beside a ready quote: what part of the balance can't go now, and why. Empty otherwise. */
  extraNotices: ExtraNotice[];
  /**
   * How many payments an amount would arrive as, split as the request would split it
   * (withdrawalPartCount on the quote's caps), so never more than the amount needs. 1 when there
   * is nothing to split by.
   */
  partsFor(amountMinor: bigint): number;
}

const onePayment = () => 1;

/** The notices' words: a person's (WITHDRAW_SPLIT_COPY) or a business's (BUSINESS_SPLIT_COPY). */
export type NoticeWords = Record<
  | 'partialTitle'
  | 'partial'
  | 'bankTitle'
  | 'bank'
  | 'bankLink'
  | 'heldTitle'
  | 'held',
  string
>;

/** The ready quote's notices (spec §6), in order: what can't be read, what to fix, what is elsewhere. */
export function quoteNotices(
  quote: WithdrawalQuoteResponse | null,
  bankHref: string = `${SETTINGS}#get-paid`,
  words: NoticeWords = WITHDRAW_SPLIT_COPY,
): ExtraNotice[] {
  if (quote?.state !== 'ready') return [];
  const notices: ExtraNotice[] = [];
  if (quote.partial)
    notices.push({
      title: words.partialTitle,
      body: words.partial,
    });
  if (quote.bankDetailsNeeded)
    notices.push({
      title: words.bankTitle,
      body: words.bank,
      href: bankHref,
      linkLabel: words.bankLink,
    });
  if (quote.heldElsewhere)
    notices.push({
      title: words.heldTitle,
      body: words.held,
    });
  return notices;
}

/** partsFor for a quote: the caps say how the request would split an amount. */
export function quoteParts(
  quote: WithdrawalQuoteResponse | null,
): (amountMinor: bigint) => number {
  if (quote?.state !== 'ready' || !quote.capsMinor?.length) return onePayment;
  const caps = quote.capsMinor.map((minor) => BigInt(minor));
  return (amountMinor) =>
    amountMinor > BigInt(0) ? (withdrawalPartCount(amountMinor, caps) ?? 1) : 1;
}

const NOTHING_NOW = 'Nothing to withdraw right now';
const NOTHING_YET = 'You have nothing to withdraw yet.';

const unavailable = {
  title: 'We can’t check your balance',
  body: 'We can’t check your balance with our payment partner right now. Try again in a few minutes.',
  tone: 'neutral',
} as const;

/**
 * What the Withdraw page says and allows. A ready quote decides (spec §6): money held where
 * withdrawals can't reach it is a notice beside the form, never a block. Without a ready quote,
 * money collected only elsewhere comes first: it must not read as a balance we couldn't check. No
 * quote at all is treated as one we couldn't get, never as a yes.
 */
export function withdrawState(input: {
  withdrawalsAvailable: boolean;
  quote: WithdrawalQuoteResponse | null;
  /** A live update changed something only a full quote can size (quote-merge.ts). */
  needsCheck?: boolean;
}): WithdrawState {
  const { quote } = input;
  const extraNotices = quoteNotices(quote);
  const partsFor = quoteParts(quote);
  return { ...decide(input), extraNotices, partsFor };
}

function decide(input: {
  withdrawalsAvailable: boolean;
  quote: WithdrawalQuoteResponse | null;
  needsCheck?: boolean;
}): Omit<WithdrawState, 'extraNotices' | 'partsFor'> {
  type Decided = Omit<WithdrawState, 'extraNotices' | 'partsFor'>;
  const { quote } = input;
  // The same words as an open row in the ledger (WithdrawRedesign, "Copy to settle").
  const review = quote?.inReview ? 'Our payment partner is checking it.' : null;
  const blocked = (
    kind: WithdrawState['kind'],
    notice: WithdrawState['notice'],
    place: WithdrawState['place'] = 'instrument',
  ): Decided => ({
    kind,
    canWithdraw: false,
    showForm: false,
    notice,
    review,
    place,
  });
  if (!input.withdrawalsAvailable && quote?.state !== 'ready')
    return blocked('held_elsewhere', {
      title: 'Withdrawals aren’t available yet',
      body: WITHDRAW_SPLIT_COPY.held,
      tone: 'neutral',
    });
  if (input.needsCheck)
    return {
      kind: 'needs_check',
      canWithdraw: false,
      showForm: true,
      notice: {
        title: 'Check what you can withdraw',
        body: 'Something changed since this page loaded. Check again to see what you can withdraw now.',
        tone: 'neutral',
      },
      review,
      place: 'instrument',
    };
  if (!quote || quote.state === 'provider_unavailable')
    return {
      kind: 'provider_unavailable',
      canWithdraw: false,
      showForm: true,
      notice: unavailable,
      review,
      place: 'instrument',
    };
  switch (quote.state) {
    case 'paused':
      if (quote.reason === 'switched_off')
        return blocked(
          'paused',
          {
            title: 'Withdrawals are paused',
            body: 'Withdrawals are paused for now. Your balance is safe.',
            tone: 'neutral',
          },
          'warning',
        );
      return blocked(
        'paused',
        {
          title: 'Withdrawals are paused',
          body: 'Withdrawals are paused while support checks your account. Questions: support@usetipme.xyz',
          tone: 'neutral',
        },
        'warning',
      );
    case 'setup_needed':
      return blocked('setup_needed', {
        title: FIRST_WITHDRAWAL_COPY.setupTitle,
        body: FIRST_WITHDRAWAL_COPY.setupBody,
        tone: 'neutral',
        href: quote.onboardingUrl ?? `${SETTINGS}#payments`,
        linkLabel: FIRST_WITHDRAWAL_COPY.setupLink,
      });
    case 'no_destination':
      return {
        ...blocked(
          'no_destination',
          {
            title: 'Add your bank account',
            body: 'Add the bank account you want to be paid to.',
            tone: 'neutral',
            href: `${SETTINGS}#get-paid`,
            linkLabel: 'Go to Get paid',
          },
          'slip',
        ),
        stamp: 'Needs\na bank',
      };
    case 'destination_pending':
      return blocked('destination_pending', {
        title: 'Your bank account is being checked',
        body: 'Your bank account is being checked. You can withdraw once it’s confirmed.',
        tone: 'neutral',
      });
    case 'ready': {
      if (quote.withdrawableMinor === '0')
        return {
          kind: 'ready',
          canWithdraw: false,
          showForm: true,
          review,
          place: 'instrument',
          notice: {
            title: NOTHING_NOW,
            body:
              quote.ledgerMinor === '0'
                ? 'You have nothing to withdraw yet.'
                : 'Your tips are still on the way to your account with our payment partner. You can withdraw them once they arrive.',
            tone: 'neutral',
          },
        };
      // When the user pays the transfer fee from the amount (a business since 12 Nov 2026, a person
      // since 25 Nov 2026): a balance not more than the fee would send nothing, so it can't be
      // withdrawn, and the page says why.
      if (
        quote.feePaidBy === 'user' &&
        BigInt(quote.withdrawableMinor) <= BigInt(quote.feeMinor)
      )
        return {
          kind: 'ready',
          canWithdraw: false,
          showForm: true,
          review,
          place: 'instrument',
          notice: {
            title: NOTHING_NOW,
            body: `Your ${formatNaira(quote.withdrawableMinor)} isn’t more than the ${formatNaira(quote.feeMinor)} transfer fee, so it can’t be withdrawn yet. It stays in your balance.`,
            tone: 'neutral',
          },
        };
      const fee = withdrawFee(quote);
      return {
        kind: 'ready',
        canWithdraw: true,
        showForm: true,
        review,
        place: 'instrument',
        notice: {
          title: 'Ready to withdraw',
          body: `You can withdraw ${formatNaira(quote.withdrawableMinor)} to ${quote.destination.bankName} ••${quote.destination.last4}.${fee ? ` ${fee}` : ''}`,
          tone: 'neutral',
        },
      };
    }
  }
}

/** What Withdraw shows a verified You collect recipient with nothing to withdraw. */
export interface CollectWithdrawView {
  /** The instrument's figure: what is on its way, or the (empty) balance. */
  figure: { caption: string; minor: string };
  lamp: { tone: LampTone; text: string };
  /** Plain sentences under the lamp, in order. */
  lines: string[];
  /** The bank chip's words ("Withdrawals go to Opay ••5629"); null without a bank on record. */
  bank: string | null;
  /** A withdrawal hold the quote reports (today's words), when there is one. */
  warning: { title: string; body: string } | null;
}

const hoursWord = (hours: number) =>
  hours === 1 ? '1 hour' : `${hours} hours`;

/**
 * The new-account delay line (owner, 23 Nov 2026), from the settings in force: only while some money
 * is on its way and the delay applies. Today's screen says it too when part has already arrived.
 */
export function collectDelayLine(
  collect: Pick<CollectStatusView, 'onItsWayMinor' | 'newAccountDelay'> | null,
): string | null {
  if (!collect?.newAccountDelay || collect.onItsWayMinor === '0') return null;
  return COLLECT_WITHDRAW_WORDS.newAccountDelay(
    hoursWord(collect.newAccountDelay.hours),
  );
}

/**
 * You collect (owner, 23 Nov 2026; ADR-0016): a verified collect recipient's tips wait with TipMe,
 * then move to their own account, and only then can be withdrawn. With nothing to withdraw now,
 * Withdraw offers no amount or Withdraw key: it says what is on its way and that it can be withdrawn
 * once it arrives, the new-account delay while it applies (from the settings, never a fixed 24),
 * what is held for a refund or a dispute, a withdrawal hold the quote reports, and where withdrawals
 * go. Null means today's screen: not on You collect, the add-bank-details form (not verified, or
 * adding the bank again), a balance that can be withdrawn, or the outcome of a withdrawal just asked
 * for still being said (`outcomeShown`: withdrawing the whole balance reloads it as ₦0, and money
 * that moved is always said).
 */
export function collectWithdrawView(input: {
  collect: Pick<
    CollectStatusView,
    | 'verified'
    | 'readdBank'
    | 'bank'
    | 'onItsWayMinor'
    | 'refundHeldMinor'
    | 'disputeHeldMinor'
    | 'newAccountDelay'
  > | null;
  availableMinor: string;
  /** The quote, when it has been read: only a hold is taken from it. */
  quote?: WithdrawalQuoteResponse | null;
  outcomeShown?: boolean;
}): CollectWithdrawView | null {
  const { collect } = input;
  if (!collect || !collect.verified || collect.readdBank) return null;
  if (input.outcomeShown) return null;
  if (BigInt(input.availableMinor) > BigInt(0)) return null;
  const coming = collect.onItsWayMinor !== '0';
  const lines: string[] = [];
  if (!coming) lines.push(NOTHING_YET);
  const delay = collectDelayLine(collect);
  if (delay) lines.push(delay);
  if (collect.refundHeldMinor !== '0')
    lines.push(
      COLLECT_HELD_NOTE.refundHeld(formatNaira(collect.refundHeldMinor)),
    );
  if (collect.disputeHeldMinor !== '0')
    lines.push(COLLECT_COPY.disputeHold(formatNaira(collect.disputeHeldMinor)));
  const hold =
    input.quote?.state === 'paused'
      ? withdrawState({ withdrawalsAvailable: true, quote: input.quote }).notice
      : null;
  return {
    figure: coming
      ? { caption: COLLECT_COPY.onItsWay, minor: collect.onItsWayMinor }
      : { caption: 'Available', minor: input.availableMinor },
    lamp: coming
      ? { tone: 'amber', text: COLLECT_WITHDRAW_WORDS.thenWithdraw }
      : { tone: 'off', text: NOTHING_NOW },
    lines,
    bank: collect.bank
      ? COLLECT_WITHDRAW_WORDS.bank(
          `${collect.bank.bankName} ••${collect.bank.last4}`,
        )
      : null,
    warning: hold ? { title: hold.title, body: hold.body } : null,
  };
}

/**
 * The fee line, when there is one. A person pays the partner's transfer fee from the amount on every
 * withdrawal (owner, 25 Nov 2026), as a business has since 12 Nov 2026. When TipMe pays it (an unused
 * top-up or a fee waiver covers it) the line says so for this withdrawal only, never that withdrawals
 * are free: the next one may cost the fee. Null for no fee or no ready quote.
 */
export function withdrawFee(
  quote: WithdrawalQuoteResponse | null,
): string | null {
  if (quote?.state !== 'ready') return null;
  if (quote.feePaidBy === 'tipme')
    return 'TipMe pays the transfer fee on this withdrawal: you receive the whole amount.';
  if (quote.feeMinor === '0') return null;
  return `Transfer fee: ${formatNaira(quote.feeMinor)}, charged by our payment partner. It comes off the amount you withdraw.`;
}

/**
 * Whether the person has never had a withdrawal paid, from the history the page already reads
 * (newest first, paged). A paid or reversed withdrawal, or a sent part, means they have; a failed one
 * doesn't count. Unknown (not loaded, or a later page unread with none paid so far) is false, so the
 * note is never said to someone it may not be true for.
 */
function neverPaid(rows: WithdrawalRow[] | null, next: string | null): boolean {
  if (rows === null || next !== null) return false;
  return !rows.some(
    (row) =>
      row.state === 'sent' ||
      row.state === 'reversed' ||
      (row.parts ?? []).some(
        (part) => part.state === 'sent' || part.state === 'reversed',
      ),
  );
}

/**
 * Said before a person confirms their first withdrawal (owner, 26 Nov 2026): it can take a few hours.
 * Only beside a ready quote, so only where a withdrawal can be asked for; a business's page never
 * calls this. Null for a second withdrawal on, or when the history isn't known.
 */
export function firstWithdrawalNote(
  quote: WithdrawalQuoteResponse | null,
  rows: WithdrawalRow[] | null,
  next: string | null,
): string | null {
  if (quote?.state !== 'ready' || !neverPaid(rows, next)) return null;
  return FIRST_WITHDRAWAL_COPY.beforeConfirm;
}

/** The same warning on a first withdrawal's row while it is requested, on its way or being checked. */
export function firstWithdrawalRowNote(
  row: WithdrawalRow,
  rows: WithdrawalRow[] | null,
  next: string | null,
): string | null {
  const open =
    row.state === 'requested' ||
    row.state === 'processing' ||
    row.state === 'in_review';
  if (!open || !neverPaid(rows, next)) return null;
  return FIRST_WITHDRAWAL_COPY.processing;
}

/**
 * Users pay the partner's whole fee (owner, 14 Nov 2026). The partner only states it once the payout
 * exists, so the quoted fee is taken from the amount and any difference is settled afterwards.
 */
export const FEE_DIFFERENCE_NOTE =
  'If our payment partner charges a different fee, the difference is taken from or added back to your balance.';

/**
 * The summary for an amount chosen: the user's fee, who pays it, and what arrives (withdraw ₦10,000,
 * receive ₦10,000 when TipMe pays; ₦9,950 under the user-pays rule). Null when there is no ready quote or nothing would arrive.
 */
export function withdrawSummary(
  quote: WithdrawalQuoteResponse | null,
  chosen: bigint,
): {
  feeMinor: bigint;
  feePaidBy: 'user' | 'tipme';
  receiveMinor: bigint;
} | null {
  if (quote?.state !== 'ready') return null;
  // What the user pays: nothing when TipMe pays the fee (owner, 18 Nov 2026).
  const feeMinor =
    quote.feePaidBy === 'user' ? BigInt(quote.feeMinor) : BigInt(0);
  const receiveMinor = chosen - feeMinor;
  if (receiveMinor <= BigInt(0)) return null;
  return { feeMinor, feePaidBy: quote.feePaidBy, receiveMinor };
}

/**
 * A withdrawal request's body: the amount, and who the summary on screen showed paying the transfer
 * fee (Ruling R6), so the server refuses rather than charge a fee the person didn't see. No summary,
 * no payer: the server decides, as for a screen from before this release.
 */
export function withdrawRequestBody(
  amountMinor: bigint | number,
  shown: { feePaidBy: 'user' | 'tipme' } | null,
): { amountMinor: string; feePaidBy?: 'user' | 'tipme' } {
  return shown
    ? { amountMinor: String(amountMinor), feePaidBy: shown.feePaidBy }
    : { amountMinor: String(amountMinor) };
}

/**
 * The one lamp line on the instrument (WithdrawRedesign §1–2), only from the state and what can go
 * now (withdrawableNow()). It states a figure or a condition, never a money reassurance.
 */
export function withdrawLamp(
  state: WithdrawState,
  withdrawableMinor: bigint,
): { tone: LampTone; text: string } {
  switch (state.kind) {
    case 'ready':
      return withdrawableMinor > BigInt(0)
        ? {
            tone: 'purple',
            text: `Ready to withdraw ${formatNaira(withdrawableMinor)}`,
          }
        : { tone: 'off', text: NOTHING_NOW };
    case 'provider_unavailable':
    case 'destination_pending':
    // A live update changed something only a full quote can size: the person checks again.
    case 'needs_check':
      return { tone: 'amber', text: state.notice.title };
    case 'no_destination':
      return { tone: 'off', text: 'Add a bank to withdraw' };
    case 'paused':
      return { tone: 'amber', text: 'Paused for now' };
    case 'setup_needed':
    case 'held_elsewhere':
      return { tone: 'off', text: state.notice.title };
  }
}

/** Refused before anything was recorded; the page's own state says why, so no message is added. */
const SHOWN_BY_PAGE: ReadonlySet<string> = new Set([
  'WITHDRAWALS_PAUSED',
  'WITHDRAWALS_SWITCHED_OFF',
  'PAYOUT_SETUP_NEEDED',
  'PAYOUT_DESTINATION_NEEDED',
  'PAYOUT_PROVIDER_UNAVAILABLE',
]);

/**
 * What the Withdraw page does with a refused request. The amount on screen can be a few seconds
 * old, because the partner's figures behind a quote are cached briefly; the withdrawal itself is
 * checked fresh. So a refusal about the amount reloads the figures, and the message stays beside
 * the new amount instead of a stale one.
 */
export function withdrawRefusal(code: string | undefined): {
  message: string | null;
  reload: boolean;
} {
  if (code !== undefined && SHOWN_BY_PAGE.has(code))
    return { message: null, reload: true };
  if (code === 'INSUFFICIENT_BALANCE')
    return {
      message: 'That is more than your available balance.',
      reload: true,
    };
  if (code === 'WITHDRAWAL_TOO_SMALL')
    return {
      message: `The smallest withdrawal is ${formatNaira(withdrawalMinimumMinor())}.`,
      reload: true,
    };
  if (code === 'WITHDRAWAL_BELOW_FEE')
    return {
      message:
        'The amount must be more than the ₦50 transfer fee, which comes off it.',
      reload: true,
    };
  // Ruling R6: who pays the fee changed since the quote on screen. Nothing was recorded; the reload
  // shows the new fee, and confirming again sends that.
  if (code === 'WITHDRAWAL_FEE_CHANGED')
    return {
      message:
        'The transfer fee changed. Check the new amount and confirm again.',
      reload: true,
    };
  if (code === 'IDEMPOTENCY_CONFLICT')
    return {
      message:
        'This withdrawal may already be on its way. Check your dashboard before asking again.',
      reload: false,
    };
  // Any other failure may have followed a request that arrived. The key stays, so the same amount
  // again can't withdraw twice, but it must not read as nothing happened.
  return {
    message:
      'We couldn’t confirm your withdrawal. Check your dashboard before trying again.',
    reload: false,
  };
}

/**
 * The refusals whose words go to a "not confirmed" slip instead of the amount field: they may have
 * followed a request that arrived, so they say nothing about money or the balance. Null for the
 * refusals the field or the page itself explains. The words are withdrawRefusal's, split at the
 * full stop.
 */
export function withdrawUnsure(
  code: string | undefined,
): { title: string; body: string } | null {
  if (code === 'IDEMPOTENCY_CONFLICT')
    return {
      title: 'This withdrawal may already be on its way',
      body: 'Check your dashboard before asking again.',
    };
  if (
    (code !== undefined && SHOWN_BY_PAGE.has(code)) ||
    code === 'INSUFFICIENT_BALANCE' ||
    code === 'WITHDRAWAL_TOO_SMALL' ||
    code === 'WITHDRAWAL_BELOW_FEE' ||
    code === 'WITHDRAWAL_FEE_CHANGED'
  )
    return null;
  return {
    title: 'We couldn’t confirm your withdrawal',
    body: 'Check your dashboard before trying again.',
  };
}

/**
 * The most that can be withdrawn right now: the ledger balance, and no more than the quote allows.
 * Zero whenever the quote refuses (paused, setup needed, tips still settling, no quote at all).
 * Withdraw and the dashboard both use this, so neither shows more as ready than the quote allows.
 */
export function withdrawableNow(input: {
  availableMinor: string;
  withdrawalsAvailable: boolean;
  quote: WithdrawalQuoteResponse | null;
  needsCheck?: boolean;
}): bigint {
  const state = withdrawState(input);
  const { quote } = input;
  if (!state.canWithdraw || quote?.state !== 'ready') return BigInt(0);
  const available = BigInt(input.availableMinor);
  const allowed = BigInt(quote.withdrawableMinor);
  return allowed < available ? allowed : available;
}

/** What the field says for an amount below the smallest withdrawal (WithdrawRedesign §2). */
export const TOO_SMALL = `Too small. The smallest withdrawal is ${formatNaira(withdrawalMinimumMinor())}, or your whole balance if it’s less.`;

/**
 * The amount is below the smallest withdrawal and isn't the whole of what can go now
 * (belowWithdrawalMinimum: the smallest tip, owner 14 Nov 2026): the server would refuse it, so the field says so before anything is sent.
 */
export function belowMinimum(
  chosen: bigint | null,
  withdrawable: bigint,
): boolean {
  return (
    chosen !== null &&
    chosen > BigInt(0) &&
    belowWithdrawalMinimum(chosen, withdrawable)
  );
}

/** One part of a request paid as more than one payment, as its row says it. */
export interface PartView {
  amountMinor: string;
  words: string;
  tone: LampTone;
}

/**
 * A request paid as parts (spec §5–§6): each part's amount and state, and "Partly sent" while some
 * parts are sent and others not. Null for a single payout. A failed part is released on its own
 * (releaseFailedPayout), so its line says the money is back (withdraw-money-lines.test.mjs).
 */
export function partsView(parts: WithdrawalRow['parts']): {
  label: string | null;
  parts: PartView[];
} | null {
  if (!parts || parts.length < 2) return null;
  const words = WITHDRAW_SPLIT_COPY.part;
  const view = parts.map((part): PartView => {
    switch (part.state) {
      case 'sent':
        return {
          amountMinor: part.amountMinor,
          words: words.sent,
          tone: 'green',
        };
      case 'failed':
        return {
          amountMinor: part.amountMinor,
          words: 'failed · back in your balance',
          tone: 'red',
        };
      case 'reversed':
        return {
          amountMinor: part.amountMinor,
          words: words.reversed,
          tone: 'red',
        };
      default:
        return {
          amountMinor: part.amountMinor,
          words: words.onItsWay,
          tone: 'amber',
        };
    }
  });
  const sent = parts.filter((part) => part.state === 'sent').length;
  return {
    label:
      sent > 0 && sent < parts.length ? WITHDRAW_SPLIT_COPY.partlySent : null,
    parts: view,
  };
}

const REQUEST_STATE: Record<
  string,
  NonNullable<WithdrawalRow['parts']>[number]['state']
> = {
  REQUESTED: 'requested',
  PROCESSING: 'processing',
  PAID: 'sent',
  FAILED: 'failed',
  REVERSED: 'reversed',
};

/** A withdrawal request's answer, as a row's parts; null for a request one payment carries. */
export function requestParts(
  parts: WithdrawalRequestResult['parts'],
): WithdrawalRow['parts'] {
  if (parts.length < 2) return null;
  return parts.map((part) => ({
    amountMinor: part.amountMinor,
    state: REQUEST_STATE[part.status] ?? 'requested',
  }));
}
