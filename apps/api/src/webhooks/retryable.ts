/**
 * Whether a database failure is about availability (the provider should retry: 503) rather than
 * a deterministic problem with this message (retrying would never help: 500). No SQLSTATE means
 * the database could not be reached at all.
 */
export function isRetryablePersistenceError(error: {
  name: string;
  sqlState?: string;
}): boolean {
  if (error.name !== 'PersistenceError') return false;
  const state = error.sqlState;
  return (
    state === undefined ||
    /^(08|53|57P)/.test(state) ||
    state === '40001' ||
    state === '40P01'
  );
}
