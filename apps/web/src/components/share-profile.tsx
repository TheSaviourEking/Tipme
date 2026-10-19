'use client';
import { useState } from 'react';
import { Button } from '@tipme/ui';
export function ShareProfile({ handle }: { handle: string }) {
  const [status, setStatus] = useState('');
  return (
    <div className="share-profile">
      <Button
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(
              `${window.location.origin}/@${handle}`,
            );
            setStatus('Demo link copied.');
          } catch {
            setStatus(
              'Copy is unavailable. You can copy the page address from your browser.',
            );
          }
        }}
      >
        Copy demo link <span aria-hidden="true">↗</span>
      </Button>
      <p role="status" className="tm-hint">
        {status}
      </p>
    </div>
  );
}
