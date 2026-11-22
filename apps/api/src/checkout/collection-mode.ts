import { bachsEnvironment, recordedProviderName } from '@tipme/contracts';
import {
  decideCollectionMode,
  featureOn,
  previewCollectionMode,
  type CollectionMode,
  type Database,
  type TipReadiness,
} from '@tipme/database';
import type { PaymentProviderName } from '@tipme/payments';

/**
 * The provider and environment a recipient's mode is decided with: the checkout provider as payment
 * rows record it, and its Bachs environment (sandbox when there is none). Checkout passes its own
 * provider (checkout.service.ts); a screen's preview passes the configured one, the same provider
 * in a running copy. One function, so the two ask the same way.
 */
export function quoteRouting(
  providerName: string,
  environment: 'sandbox' | 'live' | null | undefined,
): { provider: string; environment: 'sandbox' | 'live' } {
  return {
    provider: recordedProviderName(providerName),
    environment: environment ?? 'sandbox',
  };
}

/** The configured copy's routing, for a screen: as checkout's for the same PAYMENT_PROVIDER. */
const configuredRouting = (paymentProvider: PaymentProviderName) =>
  quoteRouting(paymentProvider, bachsEnvironment(paymentProvider));

/**
 * You collect (Task 14, re-review 2 R2-I1): the mode a recipient is on, or, undecided, the one their
 * next quote would fix now (the switch and the same inputs), without writing. What the screens use,
 * so they say what a supporter's tip would do.
 */
export async function effectiveCollectionMode(
  db: Database,
  profileId: string,
  paymentProvider: PaymentProviderName,
): Promise<CollectionMode> {
  return previewCollectionMode(db, {
    profileId,
    switchOn: await featureOn(db, 'you_collect'),
    ...configuredRouting(paymentProvider),
  });
}

/**
 * Fixes an undecided recipient's mode through the quote's own decision (decideCollectionMode, in
 * its own transaction), for a step that needs it settled: adding bank details. Only when the
 * preview says collect: a recipient it would keep direct is left exactly as they are (nothing is
 * written), and a decided recipient keeps theirs.
 */
export async function fixCollectionMode(
  db: Database,
  profileId: string,
  paymentProvider: PaymentProviderName,
): Promise<CollectionMode> {
  const inputs = {
    profileId,
    switchOn: await featureOn(db, 'you_collect'),
    ...configuredRouting(paymentProvider),
  };
  if ((await previewCollectionMode(db, inputs)) !== 'collect') return 'direct';
  return db.transaction((tx) => decideCollectionMode(tx, inputs));
}

/**
 * What a public page passes to tell whether checkout can take a new tip (re-review 3 R3-C1): on
 * Bachs, a direct tip needs the recipient's own ready account in this copy's environment, and a
 * recipient effectiveCollectionMode puts on collect needs none, as checkout itself. The pretend
 * provider needs neither (nothing is passed), as before.
 */
export function tipReadiness(
  db: Database,
  paymentProvider: PaymentProviderName,
): TipReadiness {
  const environment = bachsEnvironment(paymentProvider);
  if (!environment) return {};
  return {
    requiredAccount: { provider: 'bachs', environment },
    modeOf: (profileId) =>
      effectiveCollectionMode(db, profileId, paymentProvider),
  };
}
