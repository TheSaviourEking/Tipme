'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import type {
  OpsFeatureSwitch,
  OpsFeatureSwitchChange,
  OpsFeatureSwitches,
} from '@tipme/contracts';
import { Badge, Card, Lamp, Notice, Skeleton } from '@tipme/ui';
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
  return (
    <Card className="settings-section">
      <section
        aria-labelledby={`${id}-name`}
        data-testid={`switch-${item.key}`}
      >
        <h2 id={`${id}-name`}>
          {item.label} {item.money && <Badge>Money</Badge>}
        </h2>
        <p>{item.description}</p>
        <p data-testid="switch-state">
          <Lamp tone={item.on ? 'purple' : 'off'} />{' '}
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
        {item.history.length > 0 && (
          <details>
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
    </Card>
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
      <section className="dashboard-section">
        <h1>Switches</h1>
        <Notice tone="error" title="Couldn’t load the switches">
          Your role may not include them, or the connection failed.
        </Notice>
      </section>
    );
  if (!state)
    return (
      <section className="dashboard-section">
        <h1>Switches</h1>
        <Skeleton label="Loading the switches" />
      </section>
    );
  return (
    <section className="dashboard-section">
      <h1>Switches</h1>
      <p className="tm-hint">
        Each switch turns a feature on or off for everyone, without a deploy.
        Every copy of TipMe follows within 15 seconds.
      </p>
      {state.switches.map((item) => (
        <SwitchCard key={item.key} item={item} onChanged={read} />
      ))}
    </section>
  );
}
