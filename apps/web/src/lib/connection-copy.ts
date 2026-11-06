/**
 * The connection-failure strings (states plan, Task 17), approved by the owner on 5 Nov 2026 with
 * the plan's proposed answers to its questions 1-4 (docs/design/DECISION-LOG.md). Change them only
 * with the owner's approval. Money and safety words here are limited to what the code proves (the
 * plan's Money-safety proofs): "You haven't paid anything" only on the tip form, before the
 * redirect to the payment partner, which is the only way to pay. Nothing here is used on withdraw.
 */
export const CONNECTION_COPY = {
  /** The tip form, offline at the tap: nothing was sent. */
  tipOffline:
    'You’re offline. Connect to the internet and we’ll send your tip.',
  /** The tip form, after the quiet retry also found no connection. Carries its own safe line. */
  tipDropped:
    'Your tip didn’t go through. The connection dropped before it reached us. You haven’t paid anything. Tap Tip to send it again.',
  /** Sign-in and welcome, when TipMe answered with a fault of its own (Q2). */
  ourSide: 'This is on our side. Try again in a minute.',
  /** The tip form's version of ourSide: no redirect happened, so nothing was paid (Q2). */
  ourSideTip:
    'This is on our side. You haven’t paid anything. Try again in a minute.',
  /** The receipt slip's body, online but TipMe didn't answer. */
  receiptNoAnswer: 'We’ll check again in a moment.',
  /** The receipt slip's body, offline. */
  receiptOffline: 'You’re offline.',
  /** Sign-in, when both tries of the code check found no connection (Q1). */
  signInDropped:
    'That didn’t go through. The connection dropped before your code reached us. Tap Continue again.',
  /** Sign-in, when a dropped first try had already used the code (Q4). */
  signInCodeUsed: 'That code can’t be used now. Tap Send a new code.',
  /** Welcome, when both tries of a save found no connection (Q3). */
  welcomeDropped:
    'That didn’t save. The connection dropped. Tap Continue to try again.',
} as const;
