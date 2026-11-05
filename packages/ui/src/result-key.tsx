'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  ref,
  className,
  children,
  onFocus,
  onBlur,
  ...props
}: ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'continue';
  result?: KeyResult | null;
}) {
  const key = useRef<HTMLButtonElement | null>(null);
  const again = useRef<HTMLButtonElement | null>(null);
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
      >
        <span className="tm-key-result__face">
          <Lamp tone="red" />
          {result.label}
          {result.detail && <small>{result.detail}</small>}
        </span>
        <button
          type="button"
          className="tm-key-result__again"
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

/** One result at a time; a done result clears itself after settleMs (FeedbackMoments: about 2 s). */
export function useKeyResult(settleMs = 2000) {
  const [result, setResult] = useState<KeyResult | null>(null);

  useEffect(() => {
    if (result?.kind !== 'done') return;
    const timer = setTimeout(() => setResult(null), settleMs);
    return () => clearTimeout(timer);
  }, [result, settleMs]);

  const done = useCallback(
    (label: string) => setResult({ kind: 'done', label }),
    [],
  );
  const failed = useCallback(
    (next: Omit<FailedResult, 'kind'>) =>
      setResult({ kind: 'failed', ...next }),
    [],
  );
  const clear = useCallback(() => setResult(null), []);

  return { result, done, failed, clear };
}
