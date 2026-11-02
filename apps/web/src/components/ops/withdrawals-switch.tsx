'use client';
import type { OpsWithdrawalsSwitch } from '@tipme/contracts';
import { Notice } from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import { can, useOpsAccess, when } from '@/lib/ops-client';
import { apiFetch } from '@/lib/session-client';

/** The Overview's line and control for stopping all withdrawals. No deploy, every copy at once. */
export function WithdrawalsSwitch({
  state,
  onChanged,
}: {
  state: OpsWithdrawalsSwitch;
  onChanged: (next: OpsWithdrawalsSwitch) => void;
}) {
  const access = useOpsAccess();
  const change = async (reason: string) => {
    const paused = !state.paused;
    const result = await apiFetch('/v1/ops/withdrawals-switch', {
      method: 'POST',
      body: { paused, reason },
    });
    if (!result.ok)
      return result.code === 'FRESH_CODE_REQUIRED'
        ? 'Switching back on needs a fresh authenticator code, and this screen can’t ask for one yet. Nothing changed.'
        : 'That didn’t go through. Nothing changed.';
    onChanged({ paused, changedAt: new Date().toISOString() });
    return null;
  };
  return (
    <section aria-label="Withdrawals" data-testid="withdrawals-switch">
      {state.paused ? (
        <Notice tone="error" title="Withdrawals are OFF for everyone">
          New withdrawals are refused and queued ones wait, reserved.
          Withdrawals already with the provider can’t be recalled and still
          settle.
          {state.changedAt ? ` Since ${when(state.changedAt)}.` : ''}
        </Notice>
      ) : (
        <p>Withdrawals: on.</p>
      )}
      {can(access, 'payouts.resolve') && (
        <ReasonAction
          key={String(state.paused)}
          open={
            state.paused
              ? 'Switch withdrawals back on…'
              : 'Switch off all withdrawals…'
          }
          field={
            state.paused
              ? 'Why is it safe to start again? Queued withdrawals start at once.'
              : 'Why stop all withdrawals?'
          }
          submit={state.paused ? 'Switch on' : 'Switch off'}
          onSubmit={change}
        />
      )}
    </section>
  );
}
