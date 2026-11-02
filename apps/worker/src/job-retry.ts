import { JOB_NAMES } from '@tipme/contracts';
import {
  databaseFailureOf,
  OperationError,
  isDatabaseAvailabilityFailure,
} from '@tipme/database';
import { UnrecoverableError } from 'bullmq';

/**
 * Outbox jobs get more tries, about a minute in all: enough for a deploy's busy moment. The relay
 * marks a row published once queued, so a job that gives up is not sent again.
 */
export const RELAY_JOB_RETRIES = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 2000 },
} as const;

/**
 * What a failed job throws to the queue. Only the database being unavailable earns another try:
 * every handler is safe to repeat after one (a payout start only reads once a start was attempted),
 * and anything else fails once, as it always has. The trace probe tests the queue's own retries.
 */
export function jobFailure(jobName: string, error: unknown): unknown {
  if (
    jobName === JOB_NAMES.traceProbe ||
    isDatabaseAvailabilityFailure(error) ||
    // Refused before anything changed, and at a small pool without waiting at all.
    (error instanceof OperationError && error.code === 'STAFF_ADMIN_BUSY')
  )
    return error;
  if (error instanceof UnrecoverableError) return error;
  return new UnrecoverableError(
    error instanceof Error ? error.name : 'unknown',
  );
}

/** Fixed words and codes for a log line: never the driver's message. */
export function databaseFailureFields(error: unknown) {
  const failure = databaseFailureOf(error);
  if (!failure) return {};
  return {
    db_failure: failure.kind,
    ...(failure.sqlState ? { sql_state: failure.sqlState } : {}),
    ...(failure.errno ? { errno: failure.errno } : {}),
  };
}
