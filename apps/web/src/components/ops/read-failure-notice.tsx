'use client';
import { Button, Notice } from '@tipme/ui';
import type { ReadFailure } from '@/lib/ops-answers';

/**
 * A code-protected admin screen that couldn't load. A missing code offers the code again (the
 * retry asks for it); a refusal for the role has no button, as trying again can't change it.
 */
export function ReadFailureNotice({
  failure,
  title,
  onRetry,
}: {
  failure: ReadFailure;
  title: string;
  onRetry: () => void;
}) {
  if (failure.kind === 'forbidden')
    return (
      <Notice tone="neutral" title="Not part of your role">
        {failure.words}
      </Notice>
    );
  return (
    <Notice
      tone={failure.kind === 'needs_code' ? 'neutral' : 'error'}
      title={failure.kind === 'needs_code' ? 'Enter a code to see this' : title}
    >
      {failure.words}{' '}
      <Button variant="quiet" onClick={onRetry}>
        {failure.kind === 'needs_code' ? 'Enter a code' : 'Try again'}
      </Button>
    </Notice>
  );
}
