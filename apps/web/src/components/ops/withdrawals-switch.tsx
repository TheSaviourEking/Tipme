'use client';
import { useEffect, useState } from 'react';
import type { OpsWithdrawalsSwitch } from '@tipme/contracts';
import { Notice, Skeleton } from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import { when } from '@/lib/ops-client';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';
import { opsFetch } from '@/lib/ops-staff-api';

const PATH = '/v1/ops/withdrawals-switch';

/**
 * The Overview's line and control for stopping all withdrawals. No deploy, every copy at once. It
 * reads for itself, so the numbers failing can't take the way to stop with them. Switching off
 * takes no code and must work first time; switching on is refused without one, and the prompt asks.
 */
export function WithdrawalsSwitch() {
  const [state, setState] = useState<OpsWithdrawalsSwitch | 'unknown' | null>(
    null,
  );
  const read = () =>
    opsFetch<OpsWithdrawalsSwitch>(PATH).then((result) =>
      setState(result.ok ? result.data : 'unknown'),
    );
  useEffect(() => {
    void opsFetch<OpsWithdrawalsSwitch>(PATH).then((result) =>
      setState(result.ok ? result.data : 'unknown'),
    );
  }, []);

  const change = async (paused: boolean, reason: string) => {
    const result = await opsFetch(PATH, {
      method: 'POST',
      body: { paused, reason },
    });
    if (!result.ok) {
      // A lost answer may still have worked: what the line above says must be read, not assumed.
      if (result.code !== 'FRESH_CODE_REQUIRED') await read();
      if (outcomeIsUnknown(result)) return refusalWords(result);
      return paused
        ? `Not switched off. ${refusalWords(result)}`
        : `Not switched on. ${refusalWords(result)}`;
    }
    setState({ paused, changedAt: new Date().toISOString() });
    return null;
  };

  if (state === null)
    return <Skeleton label="Reading the withdrawals switch" />;
  const unknown = state === 'unknown';
  const paused = !unknown && state.paused;
  return (
    <section aria-label="Withdrawals" data-testid="withdrawals-switch">
      {unknown && (
        <Notice tone="error" title="We couldn’t read the withdrawals switch">
          They may be on or off. Switching off is safe either way.
        </Notice>
      )}
      {paused && (
        <Notice tone="error" title="Withdrawals are OFF for everyone">
          New withdrawals are refused and queued ones wait, reserved.
          Withdrawals already with the provider can’t be recalled and still
          settle.
          {state.changedAt ? ` Since ${when(state.changedAt)}.` : ''}
        </Notice>
      )}
      {!unknown && !paused && <p>Withdrawals: on.</p>}
      <ReasonAction
        key={String(paused)}
        open={
          paused ? 'Switch withdrawals back on…' : 'Switch off all withdrawals…'
        }
        field={
          paused
            ? 'Why is it safe to start again? Queued withdrawals start at once.'
            : 'Why stop all withdrawals?'
        }
        submit={paused ? 'Switch on' : 'Switch off'}
        errorTitle="Check what happened"
        onSubmit={(reason) => change(!paused, reason)}
      />
    </section>
  );
}
