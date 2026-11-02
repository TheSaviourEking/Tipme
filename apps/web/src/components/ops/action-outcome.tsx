'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Notice } from '@tipme/ui';

export type ActionOutcomeState =
  | {
      kind: 'done';
      text: string;
      actedAlone: boolean;
      title?: string;
      /** It ran, but the person still has something to do about it. */
      warning?: boolean;
    }
  | {
      kind: 'waiting';
      repeat: boolean;
      /** What stays true meanwhile, when that isn't obvious ("Withdrawals stay frozen"). */
      meanwhile?: string;
    };

/**
 * What a serious action came to. Waiting never reads as done, and acting alone is said plainly. The
 * form that asked has usually gone, so focus comes here rather than falling to the page.
 */
export function ActionOutcome({ outcome }: { outcome: ActionOutcomeState }) {
  const here = useRef<HTMLDivElement>(null);
  useEffect(() => {
    here.current?.focus();
  }, [outcome]);
  return (
    <div ref={here} tabIndex={-1} data-testid="action-outcome">
      <OutcomeWords outcome={outcome} />
    </div>
  );
}

function OutcomeWords({ outcome }: { outcome: ActionOutcomeState }) {
  if (outcome.kind === 'waiting')
    return (
      <Notice tone="neutral" title="Waiting for a second person">
        <p>
          {outcome.repeat
            ? 'This was already waiting, so no new request was made. Your reason is in the audit log with it. '
            : 'Nothing has changed yet. Someone else who holds this permission has to approve it, and they’ve been told. '}
          {outcome.meanwhile && `${outcome.meanwhile} `}
          <Link href="/ops/approvals">See it in Approvals</Link>
        </p>
      </Notice>
    );
  if (outcome.actedAlone)
    return (
      <Notice
        tone={outcome.warning ? 'neutral' : 'success'}
        title="Done, without a second person"
      >
        <p>
          {outcome.text} Nobody else can approve this right now, so it ran
          straight away. The log and the alert say you acted alone.
        </p>
      </Notice>
    );
  return (
    <Notice
      tone={outcome.warning ? 'neutral' : 'success'}
      title={outcome.title ?? 'Done'}
    >
      {outcome.text}
    </Notice>
  );
}

/** Turns a done-or-waiting answer into what the notice shows. */
export function outcomeOf(
  answer:
    | { kind: 'done'; actedAlone: boolean }
    | { kind: 'waiting'; repeat: boolean },
  text: string,
  meanwhile?: string,
): ActionOutcomeState {
  return answer.kind === 'waiting'
    ? {
        kind: 'waiting',
        repeat: answer.repeat,
        ...(meanwhile ? { meanwhile } : {}),
      }
    : { kind: 'done', text, actedAlone: answer.actedAlone };
}
