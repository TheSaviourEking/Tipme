'use client';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ComponentPropsWithRef, FocusEvent, Ref } from 'react';
import { Button, Lamp } from './components.js';

/**
 * Concept B, the key tells you: a quick result shown on the face of the key that was pressed.
 * `done` springs back by itself; `failed` splits the key, and its right half is a real button.
 */
export type KeyResult =
  | { kind: 'done'; label: string }
  | {
      kind: 'failed';
      label: string;
      detail?: string;
      retryLabel: string;
      onRetry(): void;
    };

type FailedResult = Extract<KeyResult, { kind: 'failed' }>;

function assign<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

/** A Button that can show its result. All Button props pass through to the key at rest. */
export function ResultKey({
  result = null,
  pending = false,
  ref,
  className,
  children,
  onClick,
  onFocus,
  onBlur,
  id,
  'data-testid': testId,
  'aria-describedby': describedBy,
  ...props
}: ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'continue';
  result?: KeyResult | null;
  /**
   * The press is being answered. The key stays focusable (aria-busy and aria-disabled, never
   * disabled) and ignores presses, so focus survives a retry instead of falling to the page.
   */
  pending?: boolean;
  'data-testid'?: string;
}) {
  const key = useRef<HTMLButtonElement | null>(null);
  const again = useRef<HTMLButtonElement | null>(null);
  const faceId = useId();
  // Whether the control on screen had focus. A focused element that is removed fires no blur
  // React can see (it is detached), so this still holds when the next result renders.
  const focused = useRef(false);
  const failed = result?.kind === 'failed';

  useEffect(() => {
    if (!focused.current) return;
    // The pressed key became Try again, or Try again became the key: keep focus on the one shown.
    const target = failed ? again.current : key.current;
    if (target && document.activeElement !== target) target.focus();
  }, [failed]);

  const track = {
    onFocus() {
      focused.current = true;
    },
    onBlur(event: FocusEvent<HTMLButtonElement>) {
      if (event.currentTarget.isConnected) focused.current = false;
    },
  };

  if (failed) {
    return (
      <div
        className={['tm-key-result tm-key-result--failed', className]
          .filter(Boolean)
          .join(' ')}
        data-result="failed"
        id={id}
        data-testid={testId}
      >
        <span className="tm-key-result__face" id={faceId}>
          <Lamp tone="red" />
          {result.label}
          {result.detail && <small>{result.detail}</small>}
        </span>
        <button
          type="button"
          className="tm-key-result__again"
          // Focus lands here on a failure, so the button carries what failed with it.
          aria-describedby={[faceId, describedBy].filter(Boolean).join(' ')}
          ref={again}
          onClick={() => result.onRetry()}
          {...track}
        >
          {result.retryLabel}
        </button>
      </div>
    );
  }

  const done = result?.kind === 'done';
  return (
    <Button
      {...props}
      id={id}
      data-testid={testId}
      aria-describedby={describedBy}
      {...(pending ? { 'aria-busy': true, 'aria-disabled': true } : {})}
      ref={(node: HTMLButtonElement | null) => {
        key.current = node;
        assign(ref, node);
      }}
      className={
        [done ? 'tm-key-result--done' : undefined, className]
          .filter(Boolean)
          .join(' ') || undefined
      }
      data-result={done ? 'done' : undefined}
      onClick={(event) => {
        if (pending) {
          // A submit key in a form would otherwise send the form again.
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      onFocus={(event) => {
        track.onFocus();
        onFocus?.(event);
      }}
      onBlur={(event) => {
        track.onBlur(event);
        onBlur?.(event);
      }}
    >
      {done ? (
        <>
          <Lamp tone="purple" />
          {result.label}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

type KeyResultOptions = {
  /** How long "Saved." stays before the key springs back (FeedbackMoments: about 2 s). */
  settleMs?: number;
  /**
   * What Try again does. Read at the moment of the press, so it sends what the form holds then,
   * never the values from when the save failed.
   */
  onRetry?: () => void;
};

/**
 * One result at a time; a done result clears itself after settleMs. `start()` marks a press in
 * flight (pass `pending` to the ResultKey).
 */
export function useKeyResult(options: number | KeyResultOptions = {}) {
  const { settleMs = 2000, onRetry } =
    typeof options === 'number' ? { settleMs: options } : options;
  const [result, setResult] = useState<KeyResult | null>(null);
  const [pending, setPending] = useState(false);
  const latestRetry = useRef(onRetry);
  useLayoutEffect(() => {
    latestRetry.current = onRetry;
  });

  useEffect(() => {
    if (result?.kind !== 'done') return;
    const timer = setTimeout(() => setResult(null), settleMs);
    return () => clearTimeout(timer);
  }, [result, settleMs]);

  const start = useCallback(() => {
    setResult(null);
    setPending(true);
  }, []);
  const done = useCallback((label: string) => {
    setPending(false);
    setResult({ kind: 'done', label });
  }, []);
  const failed = useCallback((next: Omit<FailedResult, 'kind' | 'onRetry'>) => {
    setPending(false);
    // Try again calls whatever onRetry the latest render passed, never a closure from the
    // render that failed.
    setResult({
      kind: 'failed',
      ...next,
      onRetry: () => latestRetry.current?.(),
    });
  }, []);
  const clear = useCallback(() => {
    setPending(false);
    setResult(null);
  }, []);

  return { result, pending, start, done, failed, clear };
}
