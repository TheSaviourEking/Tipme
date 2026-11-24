import { randomUUID } from 'node:crypto';
import { recordedProviderName } from '@tipme/contracts';
import {
  getPayoutDestination,
  ownerProviderSet,
  safeError,
  type Database,
  type MoneyOwner,
  type PayoutDestinationStatus,
} from '@tipme/database';
import type { PayoutPort } from '@tipme/payments';

/** What registering a bank asks of a provider. */
export type DestinationProvider = Pick<
  PayoutPort,
  'addPayoutDestination' | 'payoutDestinationStatus'
> & {
  name: string;
  capabilities?: { connectedAccounts: boolean };
};

export type AddedDestination = Awaited<
  ReturnType<PayoutPort['addPayoutDestination']>
>;

/** The bank as the person typed it. The full number goes to each provider and nowhere else. */
export interface BankToRegister {
  accountNumber: string;
  accountName: string;
  bankCode: string;
  bankName: string;
  /** You collect: the legal name's digest each provider checks the bank's name against. */
  nameDigest?: string;
}

/** Every configured provider, active first, then the withdraw-only ones in list order. */
export function activeFirst<P>(
  active: P,
  set: { active: P; withdrawOnly: readonly P[] } | undefined,
): P[] {
  return [active, ...(set?.withdrawOnly ?? []).filter((p) => p !== active)];
}

/**
 * Spec §6 "Bank details across providers": a bank added or changed is registered at every provider
 * in the owner's set, so each provider's part can be paid to the one bank the screen shows.
 *
 * - The active provider goes first. Its failure is the request's failure, exactly as before.
 * - Each other connected-account provider follows. A refusal or error there is logged for staff
 *   (`withdrawal.bank_register_failed`, with the recorded provider name) and leaves only that
 *   provider's part needing action: the quote never pays a part whose bank differs (P5).
 * - An accountless provider (the pretend ones) with no bank row counts as the same bank (P5) and is
 *   skipped. One that still holds a bank row, from when it was active, gets the new bank with the
 *   owner standing in for the account, as the active pretend provider does, so adding the bank
 *   again clears it. A provider recorded under the active one's name is skipped: the active
 *   registration owns its rows.
 * - Every save of the request shares one `changeId`, so the person gets one security email for
 *   the change, however many providers it reaches.
 *
 * The caller spends the email code once, before this. Each `save` runs `setPayoutDestination`, with
 * its own checks (cooling-off, freezes, the name lock, You collect's same-bank review), so a check
 * that refuses at one provider blocks only that provider. Provider names reach staff logs only.
 */
export async function registerBankEverywhere<
  P extends DestinationProvider,
>(input: {
  db: Database;
  owner: MoneyOwner;
  /** The configured providers, active first; only those in the owner's set are registered. */
  providers: readonly P[];
  /**
   * The account a connected-account provider's destinations hang from; null when the owner has
   * none there. Accountless providers other than the active one use the owner's id instead.
   */
  accountRefFor(provider: P): Promise<string | null>;
  bank: BankToRegister;
  /** Saves one provider's destination; `changeId` goes to `setPayoutDestination` as is. */
  save(
    provider: P,
    added: AddedDestination,
    status: PayoutDestinationStatus,
    changeId: string,
  ): Promise<void>;
  /** Staff log lines for the providers after the active one. */
  log(entry: Record<string, unknown>): void;
  /** Wraps the active provider's add, so its failure answers as the route always has. */
  callActive<T>(step: 'add', call: () => Promise<T>): Promise<T>;
  /** The active provider's status read failed: logged as the route always has. */
  onActiveUnread(error: unknown): void;
  /** What an add counts as when its status can't be read; under review unless set. */
  unreadStatus?(added: AddedDestination): PayoutDestinationStatus;
}): Promise<{ registered: string[]; needsAction: string[] }> {
  const [active, ...rest] = input.providers;
  if (!active)
    throw new Error('registerBankEverywhere needs the active provider');
  const activeName = recordedProviderName(active.name);
  // A copy with one provider asks nothing more than it always has.
  const reach =
    rest.length === 0
      ? []
      : (
          await ownerProviderSet(input.db, input.owner, {
            active,
            withdrawOnly: rest,
          })
        ).providers;
  const others = reach.filter(
    (provider) =>
      provider !== active && recordedProviderName(provider.name) !== activeName,
  );
  const changeId = randomUUID();
  const ownerId =
    'businessId' in input.owner
      ? input.owner.businessId
      : input.owner.profileId;
  const accountless = (provider: P) =>
    provider.capabilities?.connectedAccounts === false;

  const register = async (
    provider: P,
    isActive: boolean,
    step: { now: string },
  ): Promise<void> => {
    step.now = 'account';
    const reference =
      !isActive && accountless(provider)
        ? ownerId
        : await input.accountRefFor(provider);
    if (!reference) throw new Error('no account reference');
    const { bank } = input;
    step.now = 'add';
    const add = () =>
      provider.addPayoutDestination(reference, {
        accountNumber: bank.accountNumber,
        accountName: bank.accountName,
        bankCode: bank.bankCode,
        ...(bank.nameDigest ? { nameDigest: bank.nameDigest } : {}),
      });
    const added = isActive ? await input.callActive('add', add) : await add();
    // The add's key is fixed per account number, so its answer can be an old one replayed: the
    // read decides. Unread is the caller's fallback, and the next visit or sweep reads it again.
    step.now = 'read';
    let status: PayoutDestinationStatus;
    try {
      status = await provider.payoutDestinationStatus(
        reference,
        added.destinationRef,
      );
    } catch (error) {
      if (isActive) input.onActiveUnread(error);
      else
        input.log({
          event: 'withdrawal.bank_status_unread',
          provider: recordedProviderName(provider.name),
          ...safeError(error),
        });
      status = input.unreadStatus?.(added) ?? 'pending_review';
    }
    step.now = 'save';
    await input.save(provider, added, status, changeId);
  };

  await register(active, true, { now: 'account' });
  const registered = [activeName];
  const needsAction: string[] = [];
  for (const provider of others) {
    const name = recordedProviderName(provider.name);
    const step = { now: 'account' };
    try {
      // P5: no bank row at a pretend provider is the same bank already; nothing to register.
      if (
        accountless(provider) &&
        !(await getPayoutDestination(input.db, {
          ...input.owner,
          provider: name,
        }))
      )
        continue;
      await register(provider, false, step);
      registered.push(name);
    } catch (error) {
      // The error's type only: a provider message could repeat what it was sent.
      input.log({
        event: 'withdrawal.bank_register_failed',
        provider: name,
        step: step.now,
        ...safeError(error),
      });
      needsAction.push(name);
    }
  }
  return { registered, needsAction };
}
