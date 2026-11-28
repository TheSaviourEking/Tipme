/**
 * Live-update timings the browser tests also read. No imports on purpose: an e2e spec loads this
 * file through Playwright's CommonJS loader, which cannot load `@tipme/contracts` (ES module only;
 * CI run 46034166875). Same rule as the other leaf modules the specs import.
 */

/** The most a `withdrawals.changed` refetch waits when nothing of this person's is in flight. */
export const WITHDRAWALS_SPREAD_MS = 10_000;
