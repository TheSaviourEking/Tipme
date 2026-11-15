'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type {
  OpsDisplaySetting,
  OpsFeatureSwitch,
  OpsFeatureSwitchChange,
  OpsFeatureSwitches,
} from '@tipme/contracts';
import {
  Badge,
  Button,
  InputField,
  Lamp,
  Notice,
  Skeleton,
  TextareaField,
} from '@tipme/ui';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import { ReasonAction } from '@/components/ops/reason-action';
import { when } from '@/lib/ops-client';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';
import type { SessionResult } from '@/lib/session-client';

const PATH = '/v1/ops/switches';

const staffWord = (id: string | null) => (id ? `staff …${id.slice(-6)}` : '');

/** Who set a value, in a line: a start-up seed names no one. */
function who(change: OpsFeatureSwitchChange): string {
  if (change.source === 'env') return 'Carried over from the old setting';
  if (change.source === 'default') return 'Started from the default';
  const asked = staffWord(change.changedBy);
  return change.approvedBy
    ? `${asked}, approved by ${staffWord(change.approvedBy)}`
    : asked;
}

function SwitchCard({
  item,
  onChanged,
}: {
  item: OpsFeatureSwitch;
  onChanged: () => Promise<void>;
}) {
  const id = useId();
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const to = !item.on;
  const words = to ? 'on' : 'off';

  const change = async (reason: string): Promise<string | null> => {
    const answer = await opsAct<OpsFeatureSwitches>(`${PATH}/${item.key}`, {
      method: 'POST',
      body: { on: to, reason },
    });
    if (answer.kind === 'refused') {
      // A lost answer may still have worked: read what is true rather than assume.
      if (outcomeIsUnknown(answer)) await onChanged();
      return refusalWords(answer);
    }
    setOutcome(
      outcomeOf(
        answer,
        `${item.label} is now ${words}.`,
        `${item.label} stays ${item.on ? 'on' : 'off'} until then.`,
      ),
    );
    await onChanged();
    return null;
  };

  const last = item.history[0];
  // A hairline row in one paper (OpsShell board `.switch`): the words on the left, the action on
  // the right; the lamp is the success colour when on, never purple (UI audit F11).
  return (
    <section
      className="ops-switch-row"
      aria-labelledby={`${id}-name`}
      data-testid={`switch-${item.key}`}
    >
      <div className="ops-switch-row__words">
        <h2 id={`${id}-name`} className="ops-switch-row__name">
          {item.label} {item.money && <Badge>Money</Badge>}
        </h2>
        <p>{item.description}</p>
        <p data-testid="switch-state" className="ops-switch-row__state">
          <Lamp tone={item.on ? 'green' : 'off'} />{' '}
          <strong>{item.on ? 'On' : 'Off'}</strong>
          {item.on !== item.default && (
            <span className="tm-hint">
              {' '}
              (default {item.default ? 'on' : 'off'})
            </span>
          )}
        </p>
        {last && (
          <p className="tm-hint">
            {when(last.createdAt)} · {who(last)}
            <br />
            {last.reason}
          </p>
        )}
        <p className="tm-hint">
          Replaces the <code>{item.envName}</code> setting.
        </p>
      </div>
      <div className="ops-switch-row__act">
        {outcome && <ActionOutcome outcome={outcome} />}
        {item.waitingRequestId && !outcome && (
          <Notice tone="neutral" title="Waiting for a second person">
            A change is waiting in Approvals. {item.label} hasn’t changed yet.
          </Notice>
        )}
        <ReasonAction
          key={String(item.on)}
          open={`Turn ${item.label} ${words}…`}
          field={`Why turn ${item.label} ${words}?`}
          submit={item.money ? 'Ask for approval' : `Turn ${words}`}
          onSubmit={change}
        />
        {item.money && (
          <p className="tm-hint">
            This moves money, so another qualified person approves. A lone admin
            changes it alone, with an alert.
          </p>
        )}
      </div>
      {item.history.length > 0 && (
        <details className="ops-switch-row__history">
          <summary>History</summary>
          <ol className="ops-list">
            {item.history.map((change) => (
              <li key={change.id}>
                <strong>{change.on ? 'On' : 'Off'}</strong> ·{' '}
                {when(change.createdAt)} · {who(change)}
                <br />
                <span className="tm-hint">{change.reason}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

const DISPLAY_PATH = '/v1/ops/switches/display';

const number = (value: string | number) =>
  Number(value).toLocaleString('en-NG');

function displayValueWords(item: OpsDisplaySetting): string {
  if (item.kind === 'count')
    return item.set && item.value
      ? number(item.value)
      : `${number(item.count?.default ?? 0)} (the default)`;
  if (!item.set)
    return `Not set here yet: the web app still uses its ${item.envName} setting.`;
  if (item.kind === 'on_off') return item.value === 'on' ? 'On' : 'Off';
  return item.value ? when(item.value) : 'None: TipMe is open';
}

function historyValueWords(
  item: OpsDisplaySetting,
  value: string | null,
): string {
  if (value === null) return 'None';
  if (item.kind === 'instant') return when(value);
  if (item.kind === 'count') return number(value);
  return value === 'on' ? 'On' : 'Off';
}

/**
 * A display setting (owner, 14 Nov 2026, #216): the pilot notice or the launch time; and, with the
 * same rules, the announcements daily limit (15 Nov 2026). Not money: a reason and a fresh code.
 * The web app picks a display setting up within a minute; the worker reads the limit on each batch.
 */
function DisplayCard({
  item,
  onChanged,
}: {
  item: OpsDisplaySetting;
  onChanged: () => Promise<void>;
}) {
  const id = useId();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  const send = async (value: string | null, reason: string) => {
    setBusy(true);
    setError('');
    const answer = await opsAct<OpsFeatureSwitches>(
      `${DISPLAY_PATH}/${item.key}`,
      { method: 'POST', body: { value, reason } },
    );
    setBusy(false);
    if (answer.kind === 'refused') {
      if (outcomeIsUnknown(answer)) await onChanged();
      if (
        answer.code !== 'VALIDATION_FAILED' &&
        answer.code !== 'INVALID_INPUT'
      )
        return refusalWords(answer);
      return item.kind === 'count' && item.count
        ? `Check the number: a whole number from ${number(item.count.min)} to ${number(item.count.max)}, different from the one in use.`
        : 'Check the value: an exact time with its offset, such as 2026-12-01T00:00:00+01:00, or nothing. It must differ from the one in use.';
    }
    setDone(
      item.kind === 'count'
        ? `${item.label} saved. It applies from the next batch.`
        : `${item.label} saved. The web app shows it within a minute.`,
    );
    await onChanged();
    return null;
  };

  const submitValue = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = String(form.get('value') ?? '').trim();
    const reason = String(form.get('reason') ?? '').trim();
    if (reason.length < 10)
      return setError('Please write a reason of at least 10 characters.');
    const problem = await send(value === '' ? null : value, reason);
    if (problem) setError(problem);
  };

  return (
    <section
      className="ops-switch-row"
      aria-labelledby={`${id}-name`}
      data-testid={`display-${item.key}`}
    >
      <div className="ops-switch-row__words">
        <h2 id={`${id}-name`} className="ops-switch-row__name">
          {item.label}
        </h2>
        <p>{item.description}</p>
        <p data-testid="display-value">
          <strong>{displayValueWords(item)}</strong>
        </p>
        {item.set && item.changedAt && (
          <p className="tm-hint">
            {when(item.changedAt)} · {staffWord(item.changedBy)}
            <br />
            {item.reason}
          </p>
        )}
      </div>
      <div
        className={
          item.kind === 'on_off'
            ? 'ops-switch-row__act'
            : 'ops-switch-row__act ops-switch-row__act--wide'
        }
      >
        {done && (
          <Notice tone="neutral" title="Saved">
            {done}
          </Notice>
        )}
        {item.kind === 'on_off' ? (
          <ReasonAction
            key={String(item.value)}
            open={`Turn the ${item.label.toLowerCase()} ${item.value === 'on' ? 'off' : 'on'}…`}
            field={`Why turn the ${item.label.toLowerCase()} ${item.value === 'on' ? 'off' : 'on'}?`}
            submit={item.value === 'on' ? 'Turn off' : 'Turn on'}
            onSubmit={(reason) =>
              send(item.value === 'on' ? 'off' : 'on', reason)
            }
          />
        ) : (
          <form
            className="ops-reason"
            onSubmit={(e) => void submitValue(e)}
            noValidate
          >
            {item.kind === 'count' && item.count ? (
              <InputField
                id={`${id}-value`}
                name="value"
                label={item.label}
                hint={`A whole number from ${number(item.count.min)} to ${number(item.count.max)}.`}
                type="number"
                inputMode="numeric"
                min={item.count.min}
                max={item.count.max}
                step={1}
                defaultValue={item.value ?? String(item.count.default)}
                autoComplete="off"
              />
            ) : (
              <InputField
                id={`${id}-value`}
                name="value"
                label="Launch time"
                hint="An exact time with its offset, such as 2026-12-01T00:00:00+01:00 for midnight in Lagos. Leave empty for none: TipMe is open."
                defaultValue={item.value ?? ''}
                autoComplete="off"
                spellCheck={false}
              />
            )}
            <TextareaField
              id={`${id}-reason`}
              name="reason"
              label="Reason for this change"
              hint="Recorded in the audit log with your name and the time."
              maxLength={500}
            />
            {error && (
              <Notice tone="error" title="Not saved">
                {error}
              </Notice>
            )}
            <Button
              variant="continue"
              type="submit"
              disabled={busy}
              aria-busy={busy}
            >
              {item.kind === 'count'
                ? `Save ${item.label.toLowerCase()}`
                : 'Save launch time'}
            </Button>
          </form>
        )}
      </div>
      {item.history.length > 0 && (
        <details className="ops-switch-row__history">
          <summary>History</summary>
          <ol className="ops-list">
            {item.history.map((change) => (
              <li key={change.id}>
                <strong>{historyValueWords(item, change.value)}</strong> ·{' '}
                {when(change.createdAt)} · {staffWord(change.changedBy)}
                <br />
                <span className="tm-hint">{change.reason}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

/**
 * Feature switches (owner, 14 Nov 2026; docs/runbooks/settings-and-switches.md). Each turns a
 * feature on or off for everyone, with no deploy: a reason and a fresh code, and a second person for
 * one that moves money.
 */
export default function SwitchesPage() {
  const [state, setState] = useState<OpsFeatureSwitches | null>(null);
  const [failed, setFailed] = useState(false);

  const apply = useCallback((result: SessionResult<OpsFeatureSwitches>) => {
    if (!result.ok) return setFailed(true);
    setFailed(false);
    setState(result.data);
  }, []);
  const read = useCallback(
    () => opsFetch<OpsFeatureSwitches>(PATH).then(apply),
    [apply],
  );

  useEffect(() => {
    void opsFetch<OpsFeatureSwitches>(PATH).then(apply);
  }, [apply]);

  if (failed)
    return (
      <section className="dashboard-section ops-page-body">
        <h1>Switches</h1>
        <Notice tone="error" title="Couldn’t load the switches">
          Your role may not include them, or the connection failed.
        </Notice>
      </section>
    );
  if (!state)
    return (
      <section className="dashboard-section ops-page-body">
        <h1>Switches</h1>
        <Skeleton label="Loading the switches" />
      </section>
    );
  return (
    <section className="dashboard-section ops-page-body">
      <h1>Switches</h1>
      <p className="tm-hint">
        Each switch turns a feature on or off for everyone, without a deploy.
        Every copy of TipMe follows within 15 seconds.
      </p>
      <div className="ops-paper ops-switch-list">
        {state.switches.map((item) => (
          <SwitchCard key={item.key} item={item} onChanged={read} />
        ))}
      </div>
      <h2>What the web app shows</h2>
      <p className="tm-hint">
        These replace settings in the web app&apos;s hosting. Until one is set
        here, the web app keeps its own setting.
      </p>
      <div className="ops-paper ops-switch-list">
        {state.display
          .filter((item) => item.group === 'web')
          .map((item) => (
            <DisplayCard key={item.key} item={item} onChanged={read} />
          ))}
      </div>
      <h2>Limits</h2>
      <p className="tm-hint">
        Limits TipMe keeps itself. Until one is set here, its default applies.
      </p>
      <div className="ops-paper ops-switch-list">
        {state.display
          .filter((item) => item.group === 'limits')
          .map((item) => (
            <DisplayCard key={item.key} item={item} onChanged={read} />
          ))}
      </div>
    </section>
  );
}
