'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, StateLine } from '@tipme/ui';
import { stopRecognition } from '@/lib/api-client';
import { dropSupporterKey } from '@/lib/supporter-keys';

/**
 * "Stop {name} recognising me" (repeat supporters), on the receipt of a recognised tip. A sibling of
 * the note-consent withdrawal in the receipt's "Your choices" group: either can land first.
 */
export function RecognitionChoice({
  tipId,
  token,
  handle,
  name,
}: {
  tipId: string;
  token: string;
  handle: string;
  /** The recipient's first name. */
  name: string;
}) {
  const [state, setState] = useState<'idle' | 'pending' | 'done' | 'failed'>(
    'idle',
  );
  const doneLine = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state === 'done') doneLine.current?.focus();
  }, [state]);

  const stop = async () => {
    if (state === 'pending') return;
    setState('pending');
    const result = await stopRecognition(tipId, token);
    if (!result.ok) {
      setState('failed');
      return;
    }
    // The next tip to this recipient starts afresh: this browser's key for them goes too.
    try {
      dropSupporterKey(localStorage, handle);
    } catch {
      // No storage: nothing kept to drop.
    }
    setState('done');
  };

  if (state === 'done')
    return (
      <p
        className="tip-choice"
        role="status"
        tabIndex={-1}
        ref={doneLine}
        data-testid="recognition-stopped"
      >
        Done. {name} won’t see your tips grouped any more.
      </p>
    );
  return (
    <div className="tip-choice">
      <p>{name} can recognise you next time.</p>
      <Button
        variant="quiet"
        aria-busy={state === 'pending' || undefined}
        aria-describedby={
          state === 'failed' ? `${tipId}-stop-error` : undefined
        }
        onClick={() => void stop()}
      >
        Stop {name} recognising me
      </Button>
      {state === 'failed' && (
        <StateLine tone="error" id={`${tipId}-stop-error`}>
          We couldn’t stop it just now. Nothing changed. Please try again.
        </StateLine>
      )}
    </div>
  );
}
