// Home's claim field: a live check of the name once they stop typing (owner, 18 Nov 2026).
// Pure: unit tests load it (test/claim-check.test.mjs).
import type { HandleStatus } from '@tipme/contracts';
import type { SessionResult } from './session-client.ts';

/** The claim button's words. The nav keeps "Get tipped" while business sign-up is on. */
export const CLAIM_BUTTON_LABEL = 'Claim username';

/** The field's format hint (its title), shown again when a name breaks the rule. */
export const CLAIM_FORMAT_HINT =
  '3 to 30 letters, numbers or underscores. Capitals become lowercase.';

/**
 * How long after the last keystroke the name is checked. The public availability route allows 60
 * a minute per IP (RATE_LIMIT_HANDLES_PER_MIN): with this pause, answered names cached and only
 * valid-looking names sent, a person typing stays well inside it.
 */
export const CLAIM_CHECK_DELAY_MS = 450;

/** After a 429, how long the field stays quiet before checking again (the limit's window). */
export const CLAIM_PAUSE_MS = 60_000;

/** The hint shown under the field: one line on a phone. The field's title keeps the full rule. */
export const CLAIM_FORMAT_HINT_SHORT = '3–30 letters, numbers or underscores';

// The domain's handle rule (packages/domain/src/handles.ts), as in handle-hint.ts.
const HANDLE = /^[a-z0-9_]{3,30}$/;

export type ClaimCandidate =
  { kind: 'empty' } | { kind: 'invalid' } | { kind: 'check'; handle: string };

/** What the field holds, lowercased as sign-up will: nothing, a broken name, or one to check. */
export function claimCandidate(raw: string): ClaimCandidate {
  const value = raw.trim().replace(/^@/, '').toLowerCase();
  if (!value) return { kind: 'empty' };
  return HANDLE.test(value)
    ? { kind: 'check', handle: value }
    : { kind: 'invalid' };
}

export type ClaimState =
  /** The field is empty. */
  | { kind: 'idle' }
  /** They are typing: nothing is shown until they pause. */
  | { kind: 'typing' }
  | { kind: 'checking'; handle: string }
  | { kind: 'available'; handle: string }
  | { kind: 'taken' }
  | { kind: 'reserved' }
  | { kind: 'invalid' }
  /** The check failed (a lost connection, a 5xx): say nothing; sign-up still validates. */
  | { kind: 'unknown' }
  /** Rate limited: stop asking for a minute, quietly. */
  | { kind: 'paused' };

export type AvailabilityAnswer = SessionResult<{
  handle: string | null;
  status: HandleStatus;
}>;

/** The state an availability answer puts the field in. */
export function stateFromResult(
  handle: string,
  result: AvailabilityAnswer,
): ClaimState {
  if (!result.ok)
    return result.status === 429 ? { kind: 'paused' } : { kind: 'unknown' };
  const { status } = result.data;
  if (status === 'available')
    return { kind: 'available', handle: result.data.handle ?? handle };
  return { kind: status };
}

/**
 * The words under the field. A reserved name reads like any unavailable one: the public never
 * learns why (a brand, a staff reservation or one of TipMe's own words).
 */
export function claimMessage(state: ClaimState): string {
  switch (state.kind) {
    case 'available':
      return `@${state.handle} is available`;
    case 'taken':
      return 'That username is taken.';
    case 'reserved':
      return 'That username isn’t available.';
    case 'invalid':
      return CLAIM_FORMAT_HINT_SHORT;
    default:
      return '';
  }
}

type Settled = Extract<
  ClaimState,
  { kind: 'available' | 'taken' | 'reserved' | 'invalid' }
>;

export interface ClaimCheckerOptions {
  lookup: (handle: string, signal: AbortSignal) => Promise<AvailabilityAnswer>;
  onChange: (state: ClaimState) => void;
  delayMs?: number;
}

/**
 * Debounces the check: each keystroke cancels the pending pause and any request in flight; a
 * late answer for an older name is dropped. Answered names are remembered, so going back to one
 * asks nothing; a failed check is asked again next time.
 */
export class ClaimChecker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: AbortController | undefined;
  private pausedUntil = 0;
  private readonly answers = new Map<string, Settled>();

  private readonly options: ClaimCheckerOptions;

  constructor(options: ClaimCheckerOptions) {
    this.options = options;
  }

  input(raw: string): void {
    this.cancel();
    const candidate = claimCandidate(raw);
    if (candidate.kind === 'empty') {
      this.options.onChange({ kind: 'idle' });
      return;
    }
    this.options.onChange({ kind: 'typing' });
    this.timer = setTimeout(
      () => this.settle(candidate),
      this.options.delayMs ?? CLAIM_CHECK_DELAY_MS,
    );
  }

  dispose(): void {
    this.cancel();
  }

  /** Drops the pending pause and any request in flight. */
  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  private settle(candidate: Exclude<ClaimCandidate, { kind: 'empty' }>) {
    this.timer = undefined;
    if (candidate.kind === 'invalid') {
      this.options.onChange({ kind: 'invalid' });
      return;
    }
    const { handle } = candidate;
    const known = this.answers.get(handle);
    if (known) {
      this.options.onChange(known);
      return;
    }
    if (Date.now() < this.pausedUntil) {
      this.options.onChange({ kind: 'paused' });
      return;
    }
    const abort = new AbortController();
    this.inFlight = abort;
    this.options.onChange({ kind: 'checking', handle });
    void this.options.lookup(handle, abort.signal).then(
      (result) => {
        if (abort.signal.aborted) return;
        this.inFlight = undefined;
        const state = stateFromResult(handle, result);
        if (state.kind === 'paused')
          this.pausedUntil = Date.now() + CLAIM_PAUSE_MS;
        else if (state.kind !== 'unknown')
          this.answers.set(handle, state as Settled);
        this.options.onChange(state);
      },
      () => {
        if (abort.signal.aborted) return;
        this.inFlight = undefined;
        this.options.onChange({ kind: 'unknown' });
      },
    );
  }
}
