import { z } from 'zod';
import { opsReasonSchema } from './ops.js';

/**
 * Fee waivers (spec 2026-11-23): staff choose when TipMe pays the tip fee or the withdrawal fee, for
 * a kind of account or for one account, with an optional end. Amounts are minor units as digit
 * strings; the server is the only source of them.
 */

export const FEE_WAIVER_KIND_NAMES = [
  'individual',
  'business',
  'giving',
] as const;
export type FeeWaiverKindName = (typeof FEE_WAIVER_KIND_NAMES)[number];
export const FEE_WAIVER_FEE_NAMES = ['tip', 'withdrawal'] as const;
export type FeeWaiverFeeName = (typeof FEE_WAIVER_FEE_NAMES)[number];
export const FEE_WAIVER_PAYER_NAMES = ['tipme', 'account', 'inherit'] as const;
export type FeeWaiverPayerName = (typeof FEE_WAIVER_PAYER_NAMES)[number];

const minor = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);

/**
 * `POST /v1/ops/fee-waivers`: one new rule, with a reason. The shape rules (spec §4, §2):
 * - an account rule names the account that matches its kind (`profileId` for `individual`,
 *   `businessId` for `business`); a kind-wide rule names none; Giving has no accounts yet;
 * - only an account rule can `inherit` (back to the kind-wide rule);
 * - businesses have no tip fee;
 * - a kind-wide TipMe-pays rule needs `confirmCost: true` and `costEstimateMinor`, the estimate the
 *   screen showed. Without it, or when the figure has moved, the answer is 400
 *   FEE_WAIVER_CONFIRM_REQUIRED carrying the live figure (`error.costEstimateMinor`) to show and
 *   confirm. The figure is refused anywhere else.
 * Ending a waiver now is `payer: 'inherit'` (account) or `'account'` (kind-wide), with no end.
 */
export const opsFeeWaiverSetSchema = opsReasonSchema
  .extend({
    scope: z.enum(['kind', 'account']),
    kind: z.enum(FEE_WAIVER_KIND_NAMES),
    profileId: z.uuid().optional(),
    businessId: z.uuid().optional(),
    fee: z.enum(FEE_WAIVER_FEE_NAMES),
    payer: z.enum(FEE_WAIVER_PAYER_NAMES),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
    confirmCost: z.literal(true).optional(),
    costEstimateMinor: minor.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const problem = (message: string, path: string) =>
      ctx.addIssue({ code: 'custom', message, path: [path] });
    const hasPage = value.profileId !== undefined;
    const hasBusiness = value.businessId !== undefined;
    if (value.scope === 'kind') {
      if (hasPage || hasBusiness)
        problem('A kind-wide rule has no account.', 'scope');
      if (value.payer === 'inherit')
        problem('Only an account rule can inherit.', 'payer');
    } else if (value.kind === 'giving') {
      problem('Giving has no accounts yet.', 'kind');
    } else if (
      value.kind === 'individual'
        ? !hasPage || hasBusiness
        : !hasBusiness || hasPage
    ) {
      problem(
        'An account rule names the page or business its kind is for.',
        value.kind === 'individual' ? 'profileId' : 'businessId',
      );
    }
    if (value.kind === 'business' && value.fee === 'tip')
      problem('Businesses have no tip fee.', 'fee');
    if (
      value.costEstimateMinor !== undefined &&
      (value.confirmCost !== true ||
        value.scope !== 'kind' ||
        value.payer !== 'tipme')
    )
      problem(
        'A cost figure is only confirmed for a kind-wide TipMe-pays rule.',
        'costEstimateMinor',
      );
  });
export type OpsFeeWaiverSetRequest = z.infer<typeof opsFeeWaiverSetSchema>;

/** Fee income TipMe gave up and cash it paid: two figures, never added together (spec §6). */
export interface OpsFeeWaiverCost {
  incomeGivenUpMinor: string;
  cashPaidMinor: string;
}

/** One stored rule, for staff: who it is for, who set and approved it, and what it cost so far. */
export interface OpsFeeWaiverRule {
  id: string;
  scope: 'kind' | 'account';
  kind: FeeWaiverKindName;
  profileId: string | null;
  businessId: string | null;
  /** The page's handle, for an individual account rule. */
  handle: string | null;
  /** The business's name, for a business account rule. */
  businessName: string | null;
  fee: FeeWaiverFeeName;
  payer: FeeWaiverPayerName;
  startsAt: string;
  endsAt: string | null;
  /** Null for a rule a migration wrote (the carried-over business switch). */
  setBy: string | null;
  approvedBy: string | null;
  reason: string;
  /** Since the rule started, to now; zero for a rule not started yet. */
  cost: OpsFeeWaiverCost;
}

/** One cell of "Who pays the fees": the kind-wide rule in force for a kind and a fee. */
export interface OpsFeeWaiverCell {
  /** `tipme` while a kind-wide TipMe-pays rule is in force; otherwise the normal rules. */
  payer: 'tipme' | 'account';
  /** The kind-wide row in force, whatever its payer; null when there is none. */
  ruleId: string | null;
  endsAt: string | null;
  /** False for Giving, which isn't built yet: its rules are stored but nothing reads them. */
  live: boolean;
  /**
   * The kind-wide changes set to start later, soonest first, each one that changes who pays (a
   * change to the normal rules after a waiver that has already ended by then is left out).
   */
  upcoming: OpsFeeWaiverCellChange[];
}

/** A kind-wide change set to start later, on the grid. */
export interface OpsFeeWaiverCellChange {
  payer: 'tipme' | 'account';
  startsAt: string;
  endsAt: string | null;
}

/**
 * `GET /v1/ops/fee-waivers` (and a change's answer once it ran):
 * - `grid`: the kind-wide rule per kind and fee. `business.tip` is always the normal rules
 *   (businesses have no tip fee) and can't be set.
 * - `monthCost`: what waivers of each kind cost so far this Lagos month.
 * - `tipWaiversPaused`: TipMe's balance at the active payment provider is low, so new quotes
 *   ignore tip-fee waivers (spec §5) until it recovers.
 * - `inForce`: the rules in force now that change who pays. A row that only ends a waiver (an
 *   account's `inherit`, a kind-wide `account`) is no rule (spec §4) and isn't listed; an account's
 *   `account` (opting out of a kind-wide waiver) is.
 * - `upcoming`: every row not started yet, soonest first.
 * - `waitingRequestIds`: changes waiting for a second person, newest first.
 */
export interface OpsFeeWaivers {
  grid: Record<FeeWaiverKindName, Record<FeeWaiverFeeName, OpsFeeWaiverCell>>;
  monthCost: Record<FeeWaiverKindName, OpsFeeWaiverCost>;
  tipWaiversPaused: boolean;
  inForce: OpsFeeWaiverRule[];
  upcoming: OpsFeeWaiverRule[];
  waitingRequestIds: string[];
}

/** One fee on one account's ops page (spec §6: "Fees: follow the global setting / TipMe pays / normal rules"). */
export interface AccountFeeSetting {
  /** The account's own rule in force: `inherit` (also when it has none), `tipme` or `account`. */
  setting: 'inherit' | 'tipme' | 'account';
  /** The end of the account's own rule, if it has one. */
  endsAt: string | null;
  /** Who pays now, the kind-wide rule included. */
  effective: 'tipme' | 'normal';
  /** The account's own rule in force; null when it has none. */
  ruleId: string | null;
}

/**
 * `GET /v1/ops/fee-waivers/profiles/:profileId` and `/businesses/:businessId`. `tip` is null for a
 * business (it has no tip fee). `monthCost` is what waivers cost on this account so far this Lagos
 * month: its own tips and withdrawals, and for a business its team tips.
 */
export interface OpsAccountFeeWaivers {
  tip: AccountFeeSetting | null;
  withdrawal: AccountFeeSetting;
  monthCost: OpsFeeWaiverCost;
}

// The notices' words live in copy.ts (no zod), so a client page can import them on their own.
export { FEE_WAIVER_NOTICE_COPY } from './copy.js';
