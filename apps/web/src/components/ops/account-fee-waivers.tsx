'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type {
  AccountFeeSetting,
  FeeWaiverFeeName,
  FeeWaiverKindName,
  OpsAccountFeeWaivers,
  OpsFeeWaiverCost,
} from '@tipme/contracts';
import { FEE_WAIVER_STAFF_COPY as C } from '@tipme/contracts/copy';
import { Button, Card, InputField, Slip, TextareaField } from '@tipme/ui';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import { endOfLagosDay, lagosToday, untilLabel } from '@/lib/fee-waiver-dates';
import { naira } from '@/lib/money';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';
import {
  loadBusinessFeeWaivers,
  loadPageFeeWaivers,
  setFeeWaiver,
} from '@/lib/ops-client';

/** What waivers cost: two figures with their labels, never added together (spec §6). */
export function WaiverCost({ cost }: { cost: OpsFeeWaiverCost }) {
  // One element, so a stacked table cell (a two-column grid on a phone) keeps it in one place.
  return (
    <span>
      <span>
        {C.incomeGivenUp}{' '}
        <strong className="money">{naira(cost.incomeGivenUpMinor)}</strong>
      </span>
      {' · '}
      <span>
        {C.cashPaid}{' '}
        <strong className="money">{naira(cost.cashPaidMinor)}</strong>
      </span>
    </span>
  );
}

/**
 * Who pays a fee under today's rules, with no waiver (spec §2). Since profit guards (owner, 25 Nov
 * 2026) a person pays the withdrawal fee on every withdrawal, as a business does (R17).
 */
export function normalWords(
  kind: FeeWaiverKindName,
  fee: FeeWaiverFeeName,
): string {
  if (kind === 'business' && fee === 'tip') return C.noFee;
  return C.accountPays;
}

/** "TipMe pays · until 31 Jan", or "TipMe pays" with no end. */
export const tipmePaysWords = (endsAt: string | null) =>
  C.tipmePays(endsAt === null ? null : untilLabel(endsAt));

/** The account's own setting for a fee, and who pays now when it follows the global setting. */
function settingWords(
  kind: FeeWaiverKindName,
  fee: FeeWaiverFeeName,
  setting: AccountFeeSetting,
): string {
  if (setting.setting === 'tipme') return tipmePaysWords(setting.endsAt);
  if (setting.setting === 'account')
    return setting.endsAt === null
      ? C.normalOwn
      : `${C.normalOwn} · ${untilLabel(setting.endsAt)}`;
  return C.followGlobalNow(
    setting.effective === 'tipme' ? C.tipmePays(null) : normalWords(kind, fee),
  );
}

type Owner = { profileId: string } | { businessId: string };

const CHOICES = ['inherit', 'tipme', 'account'] as const;
type Choice = (typeof CHOICES)[number];

/**
 * One fee's change, closed to one button ending in "…" (PagePricing's pattern): follow the global
 * setting, TipMe pays, or the normal rules, each but the first with an optional last day.
 */
function ChangeFee({
  fee,
  current,
  onSubmit,
}: {
  fee: FeeWaiverFeeName;
  current: AccountFeeSetting;
  onSubmit: (
    choice: Choice,
    endsAt: string | null,
    reason: string,
  ) => Promise<string | null>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice>(current.setting);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const end = String(data.get('end') ?? '');
    const reason = String(data.get('reason') ?? '').trim();
    if (choice !== 'inherit' && end && end < lagosToday())
      return setError(C.endPast);
    if (reason.length < 10) return setError(C.reasonShort);
    const endsAt = choice !== 'inherit' && end ? endOfLagosDay(end) : null;
    if (
      choice === current.setting &&
      (choice === 'inherit' || endsAt === current.endsAt)
    )
      return setError(C.sameSetting);
    setBusy(true);
    setError('');
    const failed = await onSubmit(choice, endsAt, reason);
    setBusy(false);
    if (failed) setError(failed);
    else setOpen(false);
  };
  if (!open)
    return (
      <Button
        variant="secondary"
        onClick={() => {
          setChoice(current.setting);
          setError('');
          setOpen(true);
        }}
      >
        {C.changeFee(fee)}
      </Button>
    );
  return (
    <form className="ops-reason" onSubmit={(e) => void send(e)} noValidate>
      <fieldset className="ops-picker">
        <legend>{C.fees[fee]}</legend>
        {CHOICES.map((value) => (
          <label key={value} className="ops-radio">
            <input
              type="radio"
              name={`${id}-choice`}
              value={value}
              checked={choice === value}
              onChange={() => setChoice(value)}
            />
            <span>
              <strong>{C.accountChoices[value]}</strong>
              <span className="tm-hint">{C.accountHints[value]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {choice !== 'inherit' && (
        <InputField
          id={`${id}-end`}
          name="end"
          type="date"
          label={C.endLabel}
          hint={C.endHint}
          min={lagosToday()}
        />
      )}
      <TextareaField
        id={`${id}-reason`}
        name="reason"
        label={C.reasonLabel}
        hint={C.reasonHint}
        maxLength={500}
      />
      {error && (
        <Slip dense tone="error" title="Not done">
          {error}
        </Slip>
      )}
      <div className="ops-actions">
        <Button
          variant="continue"
          type="submit"
          disabled={busy}
          aria-busy={busy}
        >
          {C.submit}
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            setError('');
            setOpen(false);
          }}
        >
          {C.cancel}
        </Button>
      </div>
    </form>
  );
}

/**
 * Who pays one account's fees (spec 2026-11-23 §6): a page's tip and withdrawal fees, or a
 * business's withdrawal fee (businesses have no tip fee). Each change is the serious action
 * `fee_waiver.set`: another person approves it, it is audited, and it applies to new tips and
 * withdrawals only.
 */
export function AccountFeeWaivers({ owner }: { owner: Owner }) {
  const id = useId();
  const [state, setState] = useState<OpsAccountFeeWaivers | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const isBusiness = 'businessId' in owner;
  const accountId = isBusiness ? owner.businessId : owner.profileId;
  const kind: FeeWaiverKindName = isBusiness ? 'business' : 'individual';

  const load = useCallback(
    () =>
      isBusiness
        ? loadBusinessFeeWaivers(accountId)
        : loadPageFeeWaivers(accountId),
    [isBusiness, accountId],
  );
  useEffect(() => {
    let current = true;
    void load().then((result) => {
      if (current && result.ok) setState(result.data);
    });
    return () => {
      current = false;
    };
  }, [load]);
  const reload = async () => {
    const result = await load();
    if (result.ok) setState(result.data);
  };

  const change = async (
    fee: FeeWaiverFeeName,
    choice: Choice,
    endsAt: string | null,
    reason: string,
  ) => {
    const answer = await setFeeWaiver({
      scope: 'account',
      kind,
      ...(isBusiness ? { businessId: accountId } : { profileId: accountId }),
      fee,
      payer: choice,
      ...(endsAt === null ? {} : { endsAt }),
      reason,
    });
    if (answer.kind === 'refused') {
      if (outcomeIsUnknown(answer)) await reload();
      return answer.code === 'VALIDATION_FAILED' ||
        answer.code === 'INVALID_INPUT'
        ? C.outOfBounds
        : refusalWords(answer);
    }
    setOutcome(outcomeOf(answer, C.done, C.meanwhile));
    await reload();
    return null;
  };

  if (!state) return null;
  const fees: [FeeWaiverFeeName, AccountFeeSetting][] = [
    ...(state.tip
      ? [['tip', state.tip] as [FeeWaiverFeeName, AccountFeeSetting]]
      : []),
    ['withdrawal', state.withdrawal],
  ];
  return (
    <Card className="settings-section ops-section">
      <section aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`}>{C.title}</h2>
        <ul className="ops-list">
          {fees.map(([fee, setting]) => (
            <li key={fee} data-testid={`fee-waiver-${fee}`}>
              {C.fees[fee]}: <strong>{settingWords(kind, fee, setting)}</strong>
            </li>
          ))}
        </ul>
        <p className="tm-hint">
          {C.thisMonth}: <WaiverCost cost={state.monthCost} />
        </p>
        <p className="tm-hint">{C.hint}</p>
        {outcome && <ActionOutcome outcome={outcome} />}
        <div className="ops-actions">
          {fees.map(([fee, setting]) => (
            <ChangeFee
              key={`${fee}-${setting.ruleId ?? 'none'}-${setting.setting}`}
              fee={fee}
              current={setting}
              onSubmit={(choice, endsAt, reason) =>
                change(fee, choice, endsAt, reason)
              }
            />
          ))}
        </div>
      </section>
    </Card>
  );
}
