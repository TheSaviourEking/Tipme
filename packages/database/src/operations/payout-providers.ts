import { bachsEnvironment, recordedProviderName } from '@tipme/contracts';
import { sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import type { MoneyOwner } from './owner.js';
import type { PayoutReader } from './payouts.js';

/**
 * Every provider a withdrawal may be paid through (spec §4): the active one, which also takes new
 * tips, and the withdraw-only ones, in the order `PAYMENT_WITHDRAW_ONLY_PROVIDERS` lists them.
 */
export interface PayoutProviderSet<P extends NamedProvider = PayoutReader> {
  active: P;
  withdrawOnly: readonly P[];
}

/** What the set's own helpers need of a provider: its name (as configured) and nothing else. */
export type NamedProvider = Pick<PayoutReader, 'name'>;

/**
 * The order money is drawn in (P2): withdraw-only providers first, oldest (listed) first, so old
 * providers empty and can be retired; the active provider last.
 */
export function drainOrder<P extends NamedProvider>(
  set: PayoutProviderSet<P>,
): P[] {
  return [...set.withdrawOnly, set.active];
}

/**
 * A provider's place in the owner's set, for what is reserved out of it (`committedAtProvider`):
 * - `only`: the active provider of a plain single-provider owner (nothing in their set besides it,
 *   nothing held elsewhere), exactly as before per-provider balances;
 * - `active`: the active provider of any other owner;
 * - `withdraw_only`: any other provider in the set.
 */
export type ProviderRole = 'only' | 'active' | 'withdraw_only';

/** The role of `provider` in an owner's set (`ownerProviderSet`'s answer) with this active one. */
export function providerRoleIn<P extends NamedProvider>(
  reach: { providers: readonly P[]; heldElsewhere: boolean },
  provider: P,
  active: P,
): ProviderRole {
  if (provider !== active) return 'withdraw_only';
  return reach.providers.length > 1 || reach.heldElsewhere ? 'active' : 'only';
}

/** The bank account a payout destination names, as far as TipMe records it. */
export interface DestinationRow {
  bankCode: string;
  last4: string;
  accountHash?: string | null;
}

/**
 * Whether two destinations are the same bank account (P5): the bank and the digits the screen shows,
 * and the account hashes too when both rows have one.
 */
export function sameBank(a: DestinationRow, b: DestinationRow): boolean {
  if (a.bankCode !== b.bankCode || a.last4 !== b.last4) return false;
  if (a.accountHash && b.accountHash) return a.accountHash === b.accountHash;
  return true;
}

/** A successful tip whose money is the owner's: a person's own, or tips carrying a business's share. */
function ownersTips(owner: MoneyOwner): SQL {
  return 'businessId' in owner
    ? sql`EXISTS (SELECT 1 FROM tip_business_shares s
                   WHERE s.tip_id = t.id AND s.business_id = ${owner.businessId})`
    : sql`t.profile_id = ${owner.profileId}`;
}

/**
 * Where the owner's money has been: each recorded provider (`'bachs'`, `'mock'`, ...) that took one of
 * their successful tips, and each (provider, environment) they hold a payment account at.
 */
async function ownerFootprint(
  db: Pick<Database, 'execute'>,
  owner: MoneyOwner,
): Promise<{ tipped: Set<string>; accounts: Set<string> }> {
  const accountOwner =
    'businessId' in owner
      ? sql`business_id = ${owner.businessId}`
      : sql`profile_id = ${owner.profileId}`;
  const tipped = await db.execute<{ provider: string }>(sql`
    SELECT DISTINCT a.provider FROM tips t
      JOIN payment_attempts a ON a.intent_id = t.intent_id
     WHERE ${ownersTips(owner)} AND t.status = 'SUCCEEDED'
       AND a.status = 'VERIFIED_SUCCEEDED' AND a.provider IS NOT NULL`);
  const accounts = await db.execute<{ provider: string; environment: string }>(
    sql`SELECT DISTINCT provider, environment FROM payment_accounts
         WHERE ${accountOwner} AND provider_account_reference IS NOT NULL`,
  );
  return {
    tipped: new Set(tipped.rows.map((row) => row.provider)),
    accounts: new Set(
      accounts.rows.map((row) => `${row.provider}:${row.environment}`),
    ),
  };
}

/** Whether the owner has an account reference at, or a successful tip through, `provider`. */
function holdsAt(
  footprint: { tipped: Set<string>; accounts: Set<string> },
  provider: NamedProvider,
): boolean {
  const stored = recordedProviderName(provider.name);
  if (footprint.tipped.has(stored)) return true;
  const environment = bachsEnvironment(provider.name);
  return Boolean(
    environment && footprint.accounts.has(`${stored}:${environment}`),
  );
}

/**
 * The owner's provider set (spec §5): the configured providers, in drain order, at which the owner
 * has an account reference or which took one of their successful tips. The active provider is
 * always in it (P2), so a new owner still gets today's setup and bank states. `heldElsewhere`: a
 * successful tip went through a provider that is no longer configured, so its money can't be
 * reached from here (§6); the rest stays withdrawable.
 */
export async function ownerProviderSet<P extends NamedProvider>(
  db: Database | Tx,
  owner: MoneyOwner,
  set: PayoutProviderSet<P>,
): Promise<{ providers: P[]; heldElsewhere: boolean }> {
  const { providers, heldElsewhere } = await ownerProviderReach(db, owner, set);
  return { providers, heldElsewhere };
}

/**
 * `ownerProviderSet`, and whether any configured provider holds anything of the owner's at all (an
 * account reference there or a successful tip through it), the active one included.
 */
export async function ownerProviderReach<P extends NamedProvider>(
  db: Database | Tx,
  owner: MoneyOwner,
  set: PayoutProviderSet<P>,
): Promise<{
  providers: P[];
  heldElsewhere: boolean;
  anyConfigured: boolean;
}> {
  const footprint = await ownerFootprint(db, owner);
  const order = drainOrder(set);
  const configured = new Set(
    order.map((provider) => recordedProviderName(provider.name)),
  );
  return {
    providers: order.filter(
      (provider) => provider === set.active || holdsAt(footprint, provider),
    ),
    heldElsewhere: [...footprint.tipped].some(
      (stored) => !configured.has(stored),
    ),
    anyConfigured: order.some((provider) => holdsAt(footprint, provider)),
  };
}

/**
 * The account a bank is registered on at a provider that isn't the active one (spec §6): the
 * owner's account reference there, only once it pays out by hand. A bank added to an account that
 * pays itself out could be paid with no record at TipMe, so such an account gets none (and its
 * part is never paid either, P4). Null for a provider with no Bachs environment or no account.
 */
export async function bankAccountAt(
  db: Pick<Database, 'execute'>,
  owner: MoneyOwner,
  provider: NamedProvider,
): Promise<string | null> {
  const environment = bachsEnvironment(provider.name);
  if (!environment) return null;
  const accountOwner =
    'businessId' in owner
      ? sql`business_id = ${owner.businessId}`
      : sql`profile_id = ${owner.profileId}`;
  const result = await db.execute<{ reference: string }>(sql`
    SELECT provider_account_reference AS reference FROM payment_accounts
     WHERE ${accountOwner} AND provider = ${recordedProviderName(provider.name)}
       AND environment = ${environment} AND provider_account_reference IS NOT NULL
       AND manual_payouts_at IS NOT NULL`);
  return result.rows[0]?.reference ?? null;
}
