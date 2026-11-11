'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  BusinessBalance,
  BusinessDetail,
  BusinessPayoutAccountStart,
  WithdrawalQuoteResponse,
} from '@tipme/contracts';
import { Button, InputField, Notice, Skeleton } from '@tipme/ui';
import { GetPaidCard } from '@/components/account/get-paid-card';
import {
  businessCanSend,
  businessMoneyState,
} from '@/lib/business/money-state';
import { formatNaira } from '@/lib/demo-amount';
import { parseNaira } from '@/lib/money';
import { apiFetch } from '@/lib/session-client';
import { withdrawRefusal } from '@/lib/withdraw-state';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'off' }
  | { kind: 'failed' }
  | {
      kind: 'ready';
      balance: BusinessBalance;
      quote: WithdrawalQuoteResponse | null;
    };

/**
 * Business release 2, PR R2-B: the business's own balance (its share of tips), its bank, and
 * withdrawals of it. Owners only (the registry's `needs: 'owner'`; the API answers 404 to anyone
 * else). The quote asks our payment partner for a balance, so it is read once per visit and again
 * only after this owner's own request: no poll, no live resync.
 */
export function MoneyCard({ business }: { business: BusinessDetail }) {
  const id = useId();
  const base = `/v1/me/businesses/${business.id}`;
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [setupError, setSetupError] = useState('');
  // One key per request, so a double tap never withdraws twice.
  const key = useRef<string | null>(null);

  const load = useCallback(async () => {
    const balance = await apiFetch<BusinessBalance>(`${base}/balance`);
    if (!balance.ok) {
      // Shares are off (or this person isn't an owner): the section has nothing to show.
      setLoaded({ kind: balance.status === 404 ? 'off' : 'failed' });
      return;
    }
    const quote = await apiFetch<WithdrawalQuoteResponse>(
      `${base}/withdrawal-quote`,
    );
    setLoaded({
      kind: 'ready',
      balance: balance.data,
      quote: quote.ok ? quote.data : null,
    });
  }, [base]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  if (loaded.kind === 'loading')
    return <Skeleton label="Loading the business’s balance" />;
  if (loaded.kind === 'off')
    return (
      <p className="tm-hint">
        The business’s balance shows here once staff share tips with it.
      </p>
    );
  if (loaded.kind === 'failed')
    return (
      <Notice tone="error" title="We couldn’t load the business’s balance">
        Please reload the page.
      </Notice>
    );

  const { balance, quote } = loaded;
  const state = businessMoneyState(quote);
  const amount = parseNaira(raw.replace(/^₦\s*/, '').trim());
  const chosen = amount === null ? null : BigInt(amount);
  const withdrawable = state.withdrawableMinor;
  const minimum = BigInt(balance.minWithdrawalMinor);
  const sendable =
    chosen !== null && businessCanSend(chosen, withdrawable, minimum);
  const onTheWay = BigInt(balance.onTheWayMinor);
  const heldBack = BigInt(balance.heldBackMinor);
  const needsAccount =
    balance.payoutAccount === 'needed' ||
    balance.payoutAccount === 'setting_up';

  // Option B: the business's own payout account with our payment partner, set up by an owner.
  const setUpAccount = async () => {
    setSettingUp(true);
    setSetupError('');
    const result = await apiFetch<BusinessPayoutAccountStart>(
      `${base}/payout-account`,
      { method: 'POST', body: {} },
    );
    if (result.ok && result.data.onboardingUrl) {
      window.location.assign(result.data.onboardingUrl);
      return;
    }
    setSettingUp(false);
    if (result.ok) {
      await load();
      return;
    }
    setSetupError(
      result.code === 'EMAIL_VERIFICATION_REQUIRED'
        ? 'Confirm your email address first, then try again.'
        : 'We couldn’t reach our payment partner just now. Please try again in a few minutes.',
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!amount) {
      setError('Enter an amount, like 1000 or 1,000.50.');
      return;
    }
    setBusy(true);
    setError('');
    setDone(null);
    key.current ??= crypto.randomUUID();
    const result = await apiFetch<{ payoutId: string }>(`${base}/withdrawals`, {
      method: 'POST',
      body: { amountMinor: String(amount) },
      headers: { 'idempotency-key': key.current },
    });
    setBusy(false);
    if (result.ok) {
      setDone(formatNaira(amount));
      setRaw('');
      key.current = null;
      await load();
      return;
    }
    if (result.code === 'BALANCE_BELOW_ZERO') {
      key.current = null;
      await load();
      return;
    }
    const refusal = withdrawRefusal(result.code);
    if (refusal.message === null) key.current = null;
    if (refusal.reload) await load();
    if (refusal.message)
      setError(
        result.code === 'INSUFFICIENT_BALANCE'
          ? 'That is more than the business’s available balance.'
          : result.code === 'WITHDRAWAL_TOO_SMALL'
            ? `The smallest withdrawal for a business is ${formatNaira(balance.minWithdrawalMinor)}.`
            : refusal.message,
      );
  };

  return (
    <div className="business-money">
      <p>
        Balance:{' '}
        <strong data-testid="business-balance">
          {formatNaira(balance.balanceMinor)}
        </strong>
      </p>
      <p className="tm-hint">
        The business’s share of tips its people agreed to share. Only owners see
        this.
      </p>
      {onTheWay > BigInt(0) && (
        <p data-testid="business-on-the-way">
          On its way: <strong>{formatNaira(onTheWay)}</strong>.{' '}
          <span className="tm-hint">
            Each share reaches the business once our payment partner has settled
            its tip.
          </span>
        </p>
      )}
      {heldBack > BigInt(0) && (
        <Notice title="Held back from the next shares">
          A tip was refunded after its share had been withdrawn.{' '}
          {formatNaira(heldBack)} will be taken from the business’s next shares
          and returned to the staff member.
        </Notice>
      )}
      {needsAccount && (
        <div className="business-money__setup">
          <Button
            type="button"
            variant="secondary"
            onClick={setUpAccount}
            disabled={settingUp}
            aria-busy={settingUp}
          >
            {balance.payoutAccount === 'setting_up'
              ? 'Finish setting up the payout account'
              : 'Set up the payout account'}
          </Button>
          <p className="tm-hint">
            Our payment partner asks for the business’s registered name and a
            bank account in that name. It only receives money: it never takes
            card payments.
          </p>
          {setupError && (
            <Notice tone="error" title="Not set up yet">
              {setupError}
            </Notice>
          )}
        </div>
      )}
      <Notice title={state.notice.title}>
        {state.notice.body}
        {state.notice.href && state.notice.linkLabel && (
          <>
            {' '}
            <a href={state.notice.href}>{state.notice.linkLabel}</a>
          </>
        )}
      </Notice>
      {quote?.inReview && (
        <Notice title="Being checked">
          A withdrawal is being checked by our payment partner.
        </Notice>
      )}
      {done && (
        <Notice tone="success" title="Withdrawal requested">
          {done} is on its way to the business’s bank.
        </Notice>
      )}
      <form className="withdraw__form" onSubmit={submit} noValidate>
        <InputField
          id={`${id}-amount`}
          label="Amount (NGN)"
          inputMode="decimal"
          autoComplete="off"
          value={raw}
          disabled={!state.canWithdraw}
          onChange={(event) => {
            setRaw(event.target.value);
            setError('');
            key.current = null;
          }}
          error={error || undefined}
        />
        {state.canWithdraw && (
          <Button
            type="button"
            variant="secondary"
            aria-pressed={chosen === withdrawable}
            onClick={() => {
              setRaw(formatNaira(withdrawable));
              setError('');
              key.current = null;
            }}
          >
            Everything
          </Button>
        )}
        <Button
          type="submit"
          variant="continue"
          disabled={
            busy || !state.canWithdraw || (amount !== null && !sendable)
          }
          aria-busy={busy}
        >
          {amount ? `Withdraw ${formatNaira(amount)}` : 'Withdraw'}
        </Button>
        <p className="tm-hint">
          Once sent, a withdrawal can’t be cancelled. The smallest withdrawal
          for a business is {formatNaira(minimum)}: shares add up until then.
        </p>
      </form>
      <GetPaidCard
        destinationPath={`${base}/payout-destination`}
        anchor="business-bank"
        intro="The business’s own bank account its withdrawals go to. Changing it takes a code from your email."
      />
    </div>
  );
}
