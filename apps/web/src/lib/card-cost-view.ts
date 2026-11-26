import { cardOfferedFromNaira } from '@tipme/domain';
import { formatNaira } from './demo-amount.ts';
import { bpsToPercent, percentToBps } from './fee-percent.ts';

/*
 * The Card costs section of the ops Plan fees page (owner, 26 Nov 2026): what a card payment costs
 * TipMe, and from what tip amount card is offered on each plan at the rates in force. Staff only.
 * No React, so the rules can be tested alone; the API checks everything again.
 */

export interface CardCostFigures {
  rateBps: number;
  /** Kobo, as the API's decimal string. */
  fixedMinor: string;
  marginMinor: string;
}

// The web app targets ES2017 (no BigInt literals).
const HUNDRED = BigInt(100);

/** "Card fee 2% + ₦45, margin ₦15". */
export function cardCostSummary(cost: CardCostFigures): string {
  return `Card fee ${bpsToPercent(cost.rateBps)} + ${formatNaira(cost.fixedMinor)}, margin ${formatNaira(cost.marginMinor)}`;
}

/**
 * The whole-naira tip from which a checkout on this plan rate offers card, at that amount and every
 * one above (the share priced as the quote prices it, rounded half up to the kobo); null when the
 * rate never covers the card fee.
 */
function cardFromNaira(planBps: number, cost: CardCostFigures): string | null {
  const from = cardOfferedFromNaira(BigInt(planBps), {
    rateBps: BigInt(cost.rateBps),
    fixedMinor: BigInt(cost.fixedMinor),
    marginMinor: BigInt(cost.marginMinor),
  });
  return from === null ? null : formatNaira(from);
}

/** "Card is offered on Free tips from ₦2,000 and Pro tips from ₦6,000", from the rates in force. */
export function cardOfferLine(
  rates: { freeBps: number; proBps: number },
  cost: CardCostFigures,
): string {
  const free = cardFromNaira(rates.freeBps, cost);
  const pro = cardFromNaira(rates.proBps, cost);
  if (free && pro)
    return `Card is offered on Free tips from ${free} and Pro tips from ${pro}`;
  if (free)
    return `Card is offered on Free tips from ${free}; never on Pro tips`;
  if (pro) return `Card is offered on Pro tips from ${pro}; never on Free tips`;
  return 'Card is never offered: neither plan’s fee covers the card fee rate';
}

/** Naira typed by staff ("45", "₦1,045.50") as kobo, by integer parsing only; null when not an amount. */
export function nairaToKobo(raw: string): string | null {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(
    raw.trim().replace(/[₦,\s]/g, ''),
  );
  if (!match) return null;
  const kobo =
    BigInt(match[1] ?? '0') * HUNDRED +
    BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return String(kobo);
}

/** Kobo as the plain naira figure the inputs take: "45", "45.50". */
export function koboToNaira(minor: string): string {
  const value = BigInt(minor);
  const kobo = value % HUNDRED;
  return `${value / HUNDRED}${kobo ? `.${String(kobo).padStart(2, '0')}` : ''}`;
}

export type CardCostFormAnswer =
  | {
      ok: true;
      body: {
        rateBps: number;
        fixedMinor: string;
        marginMinor: string;
        reason: string;
      };
    }
  | { ok: false; error: string };

/** The form's fields checked before asking: each figure, a reason, and a change from the cost in use. */
export function cardCostForm(
  input: { rate: string; fixed: string; margin: string; reason: string },
  current: CardCostFigures,
): CardCostFormAnswer {
  const rateBps = percentToBps(input.rate);
  if (rateBps === null)
    return {
      ok: false,
      error:
        'Write the card fee as a percentage from 0 to 100, for example 2 or 1.5.',
    };
  const fixedMinor = nairaToKobo(input.fixed);
  if (fixedMinor === null)
    return {
      ok: false,
      error: 'Write the 3D Secure cost in naira, for example 45 or 45.50.',
    };
  const marginMinor = nairaToKobo(input.margin);
  if (marginMinor === null)
    return {
      ok: false,
      error: 'Write the margin in naira, for example 15 (0 for none).',
    };
  if (
    rateBps === current.rateBps &&
    fixedMinor === current.fixedMinor &&
    marginMinor === current.marginMinor
  )
    return {
      ok: false,
      error: 'Choose a card cost different from the one in use now.',
    };
  const reason = input.reason.trim();
  if (reason.length < 10)
    return {
      ok: false,
      error: 'Please write a reason of at least 10 characters.',
    };
  return { ok: true, body: { rateBps, fixedMinor, marginMinor, reason } };
}
