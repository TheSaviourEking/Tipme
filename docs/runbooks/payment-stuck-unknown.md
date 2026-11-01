# Runbook: a payment is stuck (pending, unknown or unresolved)

**When:** a supporter says they paid but the tip is not marked paid; an operations alert `payment.mismatch`, `payment.conflict` or `payment.unresolved` fires; or `pnpm mock:pay --scenario no-reply` locally.

## What the system already does

- Every minute the worker's `reconcile.payments` job asks the provider about attempts that have been `INITIATED`, `PENDING` or `UNKNOWN` for more than 2 minutes. A definite answer is recorded as verified evidence. It **never** charges again. Attempts that cannot resolve (for example `UNKNOWN` after a mismatch) keep being re-checked, least-recently-checked first, so they cannot block newer payments; they need a person (steps below).
- The same job asks about payouts still `REQUESTED` or `PROCESSING`, so a payout message that arrived too early (kept in `unmatched_provider_events`) or never arrived is recovered from the provider's own answer.
- The same job expires tips that were never paid (PR-007): attempts still `CREATED`/`INITIATED` whose quote expired more than 15 minutes ago. The provider is **always asked first**; a paid or failed answer is recorded as evidence, and only an unpaid attempt becomes `EXPIRED` with its tip `CANCELLED` (transitions with cause `expiry`). The supporter's status screen then shows "This tip expired", without promising that nothing was charged (a late provider success is a `payment.conflict`, step 3), and the pretend checkout refuses to take payment for it (409 `TIP_NOT_PAYABLE`).
- Log line per run: `{"event":"reconcile.completed","checked":N,"applied":N,"unresolved":N,"errors":N,"payouts_checked":N,"payouts_applied":N,"payouts_errors":N,"expired":N,"expired_paid":N,"expire_errors":N}`. `unresolved` counts new alerts only; `errors` counts checks that failed this run (they are retried next run).

## Steps

1. Find the tip: `tipProof` (or its trace via [find a trace](find-a-trace.md)). Note the attempt status and provider reference.
2. `UNKNOWN` with `payment.mismatch`: the provider reported a different amount or currency, or a fee larger than the payment. **Do not mark it paid by hand.** Compare with the provider's dashboard or report; the books stay untouched until a verified, matching event arrives.
3. `payment.conflict`: the provider reported success after a recorded failure, or for a tip that can no longer succeed (for example cancelled). Money may have been taken. Check the provider and arrange a refund or a manual review. Never rewrite the tip's history.
4. `payment.unresolved`: the provider cannot find the payment 30 minutes later. Check the provider by reference. If it truly does not exist, the supporter was not charged; the attempt expires on its own once its quote is 15 minutes past expiry.
5. A supporter's status screen says "Still checking": the attempt is `UNKNOWN` or the tip is more than 2 minutes old without a verdict. It never shows success until verified; follow steps 2–4.
6. Messages for payments TipMe does not know are in `unmatched_provider_events`. Match them by reference with the provider before acting.
7. Payout events with a reference TipMe has not recorded are parked in `unmatched_provider_events` (`reason = 'unknown_payout'`) and retried on every reconciliation run, least recently tried first; `parked_payout_checks` holds the last try. They do not open `unmatched_event`. What happens next:
   - The reference is recorded, or the event's signed reference names a live payout on that account: a read confirms it and it is applied. An event or read that differs from the request is never booked; a read that differs opens `payout_conflict`.
   - The event names a payout that already ended or has another reference: `payout_conflict` at once, before any read. Money may have left; check the provider. Only a person closes it. Exception: `payout.failed` naming a failed payout with no reference is stored without an issue, because no money moved.
   - It names no payout of ours and 10 minutes have passed: `payout_unexpected` and a withdrawal hold.
   - It names a payout but has had no usable answer for 24 hours: `payout_unresolved` (dedupe key `payout_parked.<id>`). The event keeps being retried, and this issue closes itself when the payout ends or gets a reference.

## Never

- Edit tip, attempt or ledger rows directly. The database refuses most such edits; the ones it allows bypass the audit trail.
- Retry a charge to "fix" an unknown outcome.
