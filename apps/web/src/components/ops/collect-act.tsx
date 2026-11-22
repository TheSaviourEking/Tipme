'use client';
import { useState } from 'react';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import { ReasonAction } from '@/components/ops/reason-action';
import { refusalWords } from '@/lib/ops-answers';
import { opsAct } from '@/lib/ops-staff-api';

/**
 * One You collect money action (Task 15): a button that asks for the written reason, sends it, and
 * says what it came to. Waiting for a second person never reads as done; a lone admin is told they
 * acted alone. A refusal stays in the form and says why.
 */
export function CollectAct({
  path,
  open,
  field,
  submit,
  done,
  meanwhile,
  onDone,
  variant = 'secondary',
}: {
  path: string;
  open: string;
  field: string;
  submit: string;
  /** What is true once it ran. */
  done: string;
  /** What stays true while it waits for a second person. */
  meanwhile?: string;
  onDone?: () => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'quiet';
}) {
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  if (outcome) return <ActionOutcome outcome={outcome} />;
  return (
    <ReasonAction
      open={open}
      field={field}
      submit={submit}
      variant={variant}
      onSubmit={async (reason) => {
        const answer = await opsAct(path, { method: 'POST', body: { reason } });
        if (answer.kind === 'refused') return refusalWords(answer);
        setOutcome(outcomeOf(answer, done, meanwhile));
        await onDone?.();
        return null;
      }}
    />
  );
}
