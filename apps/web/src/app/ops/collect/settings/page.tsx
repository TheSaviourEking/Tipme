'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type {
  OpsCollectSettings,
  OpsCollectSettingsValues,
} from '@tipme/contracts';
import {
  Button,
  Card,
  EmptyWell,
  InputField,
  Skeleton,
  Slip,
  TextareaField,
} from '@tipme/ui';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import { CollectAct } from '@/components/ops/collect-act';
import { LoadFailed } from '@/components/dashboard/load-failed';
import { Money } from '@/components/money';
import { refusalWords } from '@/lib/ops-answers';
import { can, useOpsAccess, when } from '@/lib/ops-client';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

const PATH = '/v1/ops/collect-settings';
const staffWord = (id: string | null) => (id ? `staff …${id.slice(-6)}` : '');

/** Whole naira typed by staff, as minor units; null when it isn't a whole amount. */
const nairaToMinor = (text: string): string | null => {
  const clean = text.replace(/[₦,\s]/g, '');
  return /^(0|[1-9][0-9]{0,9})$/.test(clean) ? `${clean}00` : null;
};
const minorToNaira = (minor: string) => String(BigInt(minor) / BigInt(100));

type Field = {
  name: keyof OpsCollectSettingsValues;
  label: string;
  hint: string;
  money?: true;
};
const FIELDS: Field[] = [
  {
    name: 'capMinor',
    label: 'Holding cap (₦)',
    hint: '₦10,000 to ₦500,000.',
    money: true,
  },
  { name: 'capDays', label: 'Holding cap (days)', hint: '7 to 90.' },
  {
    name: 'delayHours',
    label: 'New-recipient delay (hours)',
    hint: '0 to 72.',
  },
  {
    name: 'delayForDays',
    label: 'Delay applies for (days after sign-up)',
    hint: '0 to 30.',
  },
  {
    name: 'firstWithdrawalCapMinor',
    label: 'First withdrawal cap (₦)',
    hint: 'At least the minimum withdrawal.',
    money: true,
  },
  {
    name: 'newDailyLimitMinor',
    label: 'New-account daily limit (₦)',
    hint: 'Per Lagos day.',
    money: true,
  },
  {
    name: 'newDailyLimitDays',
    label: 'Daily limit applies for (days)',
    hint: 'After sign-up.',
  },
  {
    name: 'reserveWarningMinor',
    label: 'Reserve warning level (₦)',
    hint: 'TipMe’s own money.',
    money: true,
  },
  {
    name: 'reserveCriticalMinor',
    label: 'Reserve critical level (₦)',
    hint: 'Below the warning level.',
    money: true,
  },
];

/**
 * You collect's settings (spec §9), on the existing settings API (Task 12): reading and changing
 * them is `fees.manage`, and a change waits for a second person. Staff's emergency pause and resume
 * of every collect transfer (R11) are `payments.repair`, also with a second person.
 */
export default function CollectSettingsPage() {
  const id = useId();
  const access = useOpsAccess();
  const [state, setState] = useState<OpsCollectSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const load = useCallback(async () => {
    const result = await opsFetch<OpsCollectSettings>(PATH);
    setFailed(!result.ok);
    if (result.ok) setState(result.data);
  }, []);
  useEffect(() => {
    void opsFetch<OpsCollectSettings>(PATH).then((result) => {
      setFailed(!result.ok);
      if (result.ok) setState(result.data);
    });
  }, []);

  if (failed)
    return (
      <section className="dashboard-section ops-page-body">
        <h1>You collect settings</h1>
        <LoadFailed dense title="Couldn’t load the settings" onRetry={load}>
          They need the fee permission, or the connection failed.
        </LoadFailed>
      </section>
    );
  if (!state)
    return (
      <section className="dashboard-section ops-page-body">
        <h1>You collect settings</h1>
        <Skeleton label="Loading the settings" />
      </section>
    );
  const { current } = state;

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body: Record<string, unknown> = {};
    for (const field of FIELDS) {
      const text = String(data.get(field.name) ?? '').trim();
      if (field.money) {
        const minor = nairaToMinor(text);
        if (minor === null)
          return setError(`${field.label}: write a whole amount in naira.`);
        body[field.name] = minor;
      } else {
        if (!/^[0-9]{1,3}$/.test(text))
          return setError(`${field.label}: write a whole number.`);
        body[field.name] = Number(text);
      }
    }
    const reminders = String(data.get('reminderDays') ?? '')
      .split(/[,\s]+/)
      .filter(Boolean);
    if (
      reminders.length === 0 ||
      reminders.some((d) => !/^[0-9]{1,3}$/.test(d))
    )
      return setError('Reminder days: write whole days, separated by commas.');
    body['reminderDays'] = reminders.map(Number);
    const reason = String(data.get('reason') ?? '').trim();
    if (reason.length < 10)
      return setError('Please write a reason of at least 10 characters.');
    body['reason'] = reason;
    setBusy(true);
    setError('');
    const answer = await opsAct<OpsCollectSettings>(PATH, {
      method: 'POST',
      body,
    });
    setBusy(false);
    if (answer.kind === 'refused')
      return setError(
        answer.code === 'VALIDATION_FAILED'
          ? 'Check the values against their limits: each reminder before the cap’s last day, critical below warning.'
          : refusalWords(answer),
      );
    setOutcome(
      outcomeOf(
        answer,
        'The new limits are in force now.',
        'The limits in force stay the same until then.',
      ),
    );
    await load();
  };

  return (
    <section className="dashboard-section ops-page-body">
      <h1>You collect settings</h1>
      <Card className="settings-section">
        <h2>Transfers</h2>
        <p data-testid="collect-paused">
          {current.paused ? (
            <strong>Every You collect transfer is paused.</strong>
          ) : (
            'Transfers to recipients are running.'
          )}
        </p>
        {can(access, 'payments.repair') && (
          <CollectAct
            path={`/v1/ops/collect-transfers/${current.paused ? 'resume' : 'pause'}`}
            open={
              current.paused ? 'Resume transfers…' : 'Pause every transfer…'
            }
            field={
              current.paused ? 'Why resume now?' : 'Why pause every transfer?'
            }
            submit={current.paused ? 'Ask to resume' : 'Ask to pause'}
            done={
              current.paused
                ? 'Resumed: held tips move to recipients again.'
                : 'Paused: held tips stay with TipMe until resumed.'
            }
            onDone={load}
          />
        )}
      </Card>
      <Card className="settings-section">
        <h2>Limits</h2>
        <p className="tm-hint">
          {current.effectiveFrom
            ? `In force since ${when(current.effectiveFrom)}.`
            : 'TipMe’s starting limits (none set here yet).'}{' '}
          The minimum withdrawal is <Money minor={state.minWithdrawalMinor} />.
        </p>
        {outcome && <ActionOutcome outcome={outcome} />}
        {state.waitingRequestId && !outcome && (
          <Slip dense tone="waiting" title="Waiting for a second person">
            A change is waiting in Approvals. The limits haven’t changed yet.
          </Slip>
        )}
        <form className="ops-reason" onSubmit={(e) => void send(e)} noValidate>
          {FIELDS.map((field) => (
            <InputField
              key={field.name}
              id={`${id}-${field.name}`}
              name={field.name}
              label={field.label}
              hint={field.hint}
              inputMode="numeric"
              defaultValue={
                field.money
                  ? minorToNaira(String(current[field.name]))
                  : String(current[field.name])
              }
            />
          ))}
          <InputField
            id={`${id}-reminders`}
            name="reminderDays"
            label="Reminder days"
            hint="Days after the first waiting tip, each before the cap’s last day. For example 7, 21, 28."
            defaultValue={current.reminderDays.join(', ')}
          />
          <TextareaField
            id={`${id}-reason`}
            name="reason"
            label="Reason for this change"
            hint="Recorded in the audit log with your name and the time."
            maxLength={500}
          />
          {error && (
            <Slip dense tone="error" title="Not done">
              {error}
            </Slip>
          )}
          <Button
            variant="continue"
            type="submit"
            disabled={busy}
            aria-busy={busy}
          >
            Ask for approval
          </Button>
        </form>
      </Card>
      <Card className="settings-section">
        <h2>History</h2>
        {state.history.length === 0 ? (
          <EmptyWell title="No changes yet" headingLevel={3}>
            <p>Changes appear here once made.</p>
          </EmptyWell>
        ) : (
          <ol className="ops-list">
            {state.history.map((row) => (
              <li key={row.id}>
                <strong>
                  Cap <Money minor={row.capMinor} /> or {row.capDays} days
                  {row.paused ? ' · transfers paused' : ''}
                </strong>{' '}
                · {when(row.effectiveFrom)} ·{' '}
                {row.setBy
                  ? `${staffWord(row.setBy)}${row.approvedBy ? `, approved by ${staffWord(row.approvedBy)}` : ', alone'}`
                  : 'Starting limits'}
                <br />
                <span className="tm-hint">{row.reason}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </section>
  );
}
