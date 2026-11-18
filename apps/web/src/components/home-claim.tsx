'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { HandleStatus } from '@tipme/contracts';
import { Button } from '@tipme/ui';
import {
  CLAIM_BUTTON_LABEL,
  CLAIM_FORMAT_HINT,
  ClaimChecker,
  claimMessage,
  type ClaimState,
} from '@/lib/claim-check';
import { apiFetch } from '@/lib/session-client';

/**
 * Home's claim field: a plain GET form to sign-up, so it works before (and without) JavaScript.
 * Once they stop typing, the name is checked (owner, 18 Nov 2026): a check and "@name is
 * available", or a short reason. An available name lights the button and nudges it once (again
 * once a few seconds later); with reduced motion it only lights. The button always works, and
 * sign-up checks the name again, whatever this said.
 */
export function HomeClaim() {
  const id = useId();
  const [state, setState] = useState<ClaimState>({ kind: 'idle' });
  const checker = useRef<ClaimChecker | null>(null);

  useEffect(() => {
    const current = new ClaimChecker({
      lookup: (handle, signal) =>
        apiFetch<{ handle: string | null; status: HandleStatus }>(
          `/v1/handles/${encodeURIComponent(handle)}/availability`,
          { signal },
        ),
      onChange: setState,
    });
    checker.current = current;
    return () => current.dispose();
  }, []);

  const message = claimMessage(state);
  const available = state.kind === 'available';
  const statusId = `${id}-status`;

  return (
    <form
      className="home-claim"
      action="/sign-up"
      method="get"
      aria-label="Claim your link"
    >
      <label className="tm-well home-claim__field" data-state={state.kind}>
        <span className="home-claim__prefix">usetipme.xyz/@</span>
        <input
          name="handle"
          aria-label="Your username"
          aria-describedby={statusId}
          placeholder="yourname"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={30}
          pattern="[A-Za-z0-9_]{3,30}"
          title={CLAIM_FORMAT_HINT}
          onInput={(event) => checker.current?.input(event.currentTarget.value)}
        />
        {/* The words below say the same, so the marks stay out of the accessibility tree. */}
        <span className="home-claim__mark" aria-hidden="true">
          {available ? (
            <svg viewBox="0 0 20 20" className="home-claim__check">
              <circle cx="10" cy="10" r="10" />
              <path d="m5.75 10.25 2.75 2.75 5.75-6" />
            </svg>
          ) : state.kind === 'checking' ? (
            <span className="home-claim__spinner" />
          ) : null}
        </span>
      </label>
      <Button
        type="submit"
        variant="continue"
        className="home-claim__go"
        data-ready={available ? 'true' : undefined}
      >
        {CLAIM_BUTTON_LABEL}
      </Button>
      <p
        id={statusId}
        className="home-claim__status"
        data-state={state.kind}
        aria-live="polite"
      >
        {message}
      </p>
    </form>
  );
}
