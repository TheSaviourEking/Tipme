'use client';
import { Button, Notice } from '@tipme/ui';
import { CHANGED_ELSEWHERE } from '@/lib/live-form';

/** Shown beside a form whose saved value changed elsewhere while the person was editing it. */
export function ChangedElsewhere({
  onShowLatest,
}: {
  onShowLatest: () => void;
}) {
  return (
    <Notice tone="neutral" title={CHANGED_ELSEWHERE.message}>
      Your unsaved edits are still here.{' '}
      <Button variant="secondary" onClick={onShowLatest}>
        {CHANGED_ELSEWHERE.action}
      </Button>
    </Notice>
  );
}
