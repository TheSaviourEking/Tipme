'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { OpsMailProviderCard, OpsMailProviders } from '@tipme/contracts';
import {
  Button,
  Card,
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
import { ReasonAction } from '@/components/ops/reason-action';
import { can, useOpsAccess, when } from '@/lib/ops-client';
import { outcomeIsUnknown, refusalWords } from '@/lib/ops-answers';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

const clock = new Intl.DateTimeFormat('en-GB', {
  timeStyle: 'short',
  timeZone: 'Africa/Lagos',
});
/** HH:MM, Lagos time, as staff read it. */
const at = (iso: string) => clock.format(new Date(iso));

/** Automatic failover's view of one provider (owner, 23 Nov 2026). */
function HealthLine({
  card,
  canManage,
  onChange,
}: {
  card: OpsMailProviderCard;
  canManage: boolean;
  onChange: () => void;
}) {
  const health = card.health;
  if (!health) return null;
  if (health.state === 'healthy')
    return (
      <p data-testid={`health-${card.name}`}>
        Failover: healthy.
        {health.trippedAt && health.reason
          ? ` Last tripped ${when(health.trippedAt)}: ${health.reason}.`
          : ''}
      </p>
    );
  const trial =
    health.kind === 'codes'
      ? 'the next few sign-in and other codes go through it, and if people use them it is back'
      : 'one email goes through it, and if that works it is back';
  return (
    <Slip
      dense
      tone={health.state === 'resting' ? 'error' : 'waiting'}
      title={
        health.state === 'resting' && health.until
          ? `Resting until ${at(health.until)}`
          : 'On trial'
      }
    >
      <span data-testid={`health-${card.name}`}>
        {health.reason ?? 'Tripped'}.{' '}
        {health.state === 'resting'
          ? 'New mail goes through the backup meanwhile.'
          : `Now ${trial}.`}
      </span>
      {canManage && (
        <ReasonAction
          open="Clear"
          field="Why clear this provider by hand?"
          submit="Mark it healthy"
          onSubmit={async (reason) => {
            const result = await opsFetch<{ cleared: boolean }>(
              `/v1/ops/providers/mail/${card.name}/health/clear`,
              { method: 'POST', body: { reason } },
            );
            if (result.ok) {
              onChange();
              return null;
            }
            return result.code === 'DEPENDENCY_UNAVAILABLE'
              ? 'The failover state can’t be reached right now. Try again in a minute.'
              : 'That didn’t go through. Please try again.';
          }}
        />
      )}
    </Slip>
  );
}

/** Which provider is live, the backup, and the "fixed" choice. */
function Failover({
  data,
  canManage,
  onChange,
}: {
  data: OpsMailProviders;
  canManage: boolean;
  onChange: () => void;
}) {
  const label = (name: string | null) =>
    data.providers.find((p) => p.name === name)?.label ?? name ?? '';
  const { failover } = data;
  if (!failover.configured)
    return (
      <Card className="settings-section" data-testid="failover">
        <h2>Automatic failover</h2>
        <p>
          Off on this copy: all email goes through the active provider, and
          nothing switches by itself.
        </p>
      </Card>
    );
  const active = data.providers.find((p) => p.active)?.name ?? null;
  return (
    <Card className="settings-section" data-testid="failover">
      <h2>Automatic failover</h2>
      <p>
        <strong>Live now: {label(failover.live)}</strong>
        {failover.live !== active
          ? ` (${label(active)} is resting or on trial)`
          : ''}
        .
      </p>
      {failover.fixed ? (
        <p>
          Fixed: everything goes through {label(active)}, and nothing switches
          by itself until staff let it.
        </p>
      ) : (
        <p>
          When {label(active)} fails for sure (3 failed sends in 5 minutes) or
          too many codes it sends go unused, new email moves to{' '}
          {label(failover.backup)} for 15 minutes, then comes back once{' '}
          {label(active)} works again. Staff are alerted each time.
        </p>
      )}
      {canManage && (
        <ReasonAction
          open={
            failover.fixed
              ? 'Let it switch automatically'
              : 'Fix the active provider'
          }
          field={
            failover.fixed
              ? 'Why let it switch again?'
              : 'Why fix the provider (e.g. an investigation)?'
          }
          submit={failover.fixed ? 'Switch automatically' : 'Fix provider'}
          onSubmit={async (reason) => {
            const result = await opsFetch('/v1/ops/providers/mail/failover', {
              method: 'POST',
              body: { fixed: !failover.fixed, reason },
            });
            if (result.ok) {
              onChange();
              return null;
            }
            return 'That didn’t go through. Please try again.';
          }}
        />
      )}
    </Card>
  );
}

const TEST_STATUS: Record<string, string> = {
  pending: 'Waiting for the link in the email to be opened',
  confirmed: 'Confirmed',
  failed: 'The test email didn’t get through',
  expired: 'Not confirmed within 24 hours. Send a new test',
};

function ProviderCard({
  card,
  canManage,
  onChange,
}: {
  card: OpsMailProviderCard;
  canManage: boolean;
  onChange: () => void;
}) {
  const id = useId();
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const test = card.lastTest;
  const sendTest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const to = String(data.get('to') ?? '').trim();
    const reason = String(data.get('reason') ?? '').trim();
    const result = await opsFetch(`/v1/ops/providers/mail/${card.name}/test`, {
      method: 'POST',
      body: { reason, ...(to ? { to } : {}) },
    });
    if (result.ok) {
      setTesting(false);
      setError('');
      onChange();
    } else
      setError(
        result.code === 'EMAIL_VERIFICATION_REQUIRED'
          ? 'Your account has no confirmed email. Type the address to send the test to.'
          : 'The test didn’t start. Check the address and reason, then try again.',
      );
  };
  const [error, setError] = useState('');
  return (
    <Card className="settings-section" data-testid={`provider-${card.name}`}>
      <h2>{card.label}</h2>
      {outcome && <ActionOutcome outcome={outcome} />}
      {card.active && (
        <p>
          <strong>Active</strong>
        </p>
      )}
      {card.sandbox === true ? (
        <Slip dense tone="neutral" title="Sandbox">
          This provider only delivers to verified recipients
          {card.statusDetail ? ` (${card.statusDetail})` : ''}. It can’t be made
          active in production.
        </Slip>
      ) : (
        <p>
          {card.sandbox === false
            ? `Status: live${card.statusDetail ? `, ${card.statusDetail}` : ''}.`
            : 'Status: unknown until a test is confirmed.'}
        </p>
      )}
      <HealthLine card={card} canManage={canManage} onChange={onChange} />
      <p>
        Last 24 hours: {card.last24h.sent} sent, {card.last24h.failed} failed
        attempts, {card.last24h.bounced} bounced, {card.last24h.complained}{' '}
        complaints.
      </p>
      {test ? (
        <p>
          {test.status === 'pending' &&
            `Test sent to ${test.targetHint ?? 'staff'} ${when(test.startedAt)}. `}
          {test.status === 'pending' && test.failureCode
            ? `Retrying: ${test.failureCode}.`
            : `${TEST_STATUS[test.status]}${test.confirmedAt ? ` ${when(test.confirmedAt)}` : ''}${
                test.status === 'failed' && test.failureCode
                  ? `: ${test.failureCode}`
                  : ''
              }.`}
        </p>
      ) : (
        <p>Not tested yet.</p>
      )}
      {canManage && (
        <div className="ops-actions">
          {testing ? (
            <form className="settings-form" onSubmit={(e) => void sendTest(e)}>
              <InputField
                id={`${id}-to`}
                name="to"
                type="email"
                label="Send the test to"
                hint="Leave empty to use your own confirmed email."
                maxLength={254}
              />
              <TextareaField
                id={`${id}-reason`}
                name="reason"
                label="Why are you testing this provider?"
                hint="Recorded in the audit log with your name and the time."
                minLength={10}
                maxLength={500}
                required
              />
              {error && (
                <Slip dense tone="error" title="Not sent">
                  {error}
                </Slip>
              )}
              <Button variant="continue" type="submit">
                Send the test email
              </Button>
            </form>
          ) : (
            <Button variant="secondary" onClick={() => setTesting(true)}>
              Send test
            </Button>
          )}
          {!card.active &&
            (card.canActivate ? (
              <ReasonAction
                open="Make active"
                field="Why are you switching?"
                submit="Switch provider"
                variant="primary"
                onSubmit={async (reason) => {
                  const answer = await opsAct('/v1/ops/providers/mail/active', {
                    method: 'POST',
                    body: { provider: card.name, reason },
                  });
                  if (answer.kind !== 'refused') {
                    setOutcome(
                      outcomeOf(
                        answer,
                        `${card.name} is now the active provider.`,
                      ),
                    );
                    onChange();
                    return null;
                  }
                  if (outcomeIsUnknown(answer)) onChange();
                  return answer.code === 'PROVIDER_NOT_ALLOWED'
                    ? 'This provider can’t be made active in production.'
                    : refusalWords(answer);
                }}
              />
            ) : (
              <p>
                To make it active, send a test and open the link in the email. A
                confirmed test counts for 24 hours.
              </p>
            ))}
        </div>
      )}
    </Card>
  );
}

function Overrides({
  data,
  canManage,
  onChange,
}: {
  data: OpsMailProviders;
  canManage: boolean;
  onChange: () => void;
}) {
  const id = useId();
  const [error, setError] = useState('');
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const result = await opsFetch('/v1/ops/providers/overrides', {
      method: 'POST',
      body: {
        account: String(values.get('account') ?? '').trim(),
        provider: String(values.get('provider') ?? ''),
        reason: String(values.get('reason') ?? '').trim(),
      },
    });
    if (!result.ok) {
      setError(
        result.code === 'NOT_FOUND'
          ? 'No account with that username or id, or that provider isn’t configured.'
          : 'That didn’t save. Please check the fields and try again.',
      );
      return;
    }
    setError('');
    form.reset();
    onChange();
  };
  return (
    <Card className="settings-section">
      <h2>Accounts on their own provider</h2>
      <p>
        A pinned account’s email goes through its provider, whichever one is
        active.
      </p>
      {data.overrides.length === 0 ? (
        <p>No accounts are pinned.</p>
      ) : (
        <ul className="ops-list">
          {data.overrides.map((o) => (
            <li
              key={o.userId}
              className="ops-row"
              data-testid={`override-${o.handle ?? o.userId}`}
            >
              <p>
                <strong>{o.handle ? `@${o.handle}` : o.userId}</strong> →{' '}
                {o.provider}. {o.reason} ({when(o.createdAt)})
              </p>
              {canManage && (
                <ReasonAction
                  open="Remove"
                  field="Why remove this pin?"
                  submit="Remove pin"
                  onSubmit={async (reason) => {
                    const result = await opsFetch(
                      '/v1/ops/providers/overrides/remove',
                      {
                        method: 'POST',
                        body: { userId: o.userId, reason },
                      },
                    );
                    if (result.ok) {
                      onChange();
                      return null;
                    }
                    return 'That didn’t go through. Please try again.';
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <form className="settings-form" onSubmit={(e) => void add(e)}>
          <InputField
            id={`${id}-account`}
            name="account"
            label="Account (username or user id)"
            maxLength={64}
            required
          />
          <div className="tm-field">
            <label htmlFor={`${id}-provider`}>Provider</label>
            <select id={`${id}-provider`} name="provider" className="tm-input">
              {data.providers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <TextareaField
            id={`${id}-reason`}
            name="reason"
            label="Why does this account need its own provider?"
            hint="Recorded in the audit log with your name and the time."
            minLength={10}
            maxLength={500}
            required
          />
          {error && (
            <Slip dense tone="error" title="Not saved">
              {error}
            </Slip>
          )}
          <Button type="submit" variant="secondary">
            Pin account
          </Button>
        </form>
      )}
    </Card>
  );
}

function Suppressions({ canManage }: { canManage: boolean }) {
  const id = useId();
  const [address, setAddress] = useState('');
  const [found, setFound] = useState<
    { reason: string; createdAt: string } | null | undefined
  >(undefined);
  const lookup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = await opsFetch<{
      suppression: { reason: string; createdAt: string } | null;
    }>('/v1/ops/providers/suppressions/lookup', {
      method: 'POST',
      body: { address },
    });
    setFound(result.ok ? result.data.suppression : undefined);
  };
  const REASONS: Record<string, string> = {
    hard_bounce: 'The address bounced permanently',
    complaint: 'The person marked an email as spam',
    repeated_soft_bounce: 'The address bounced three times in 7 days',
    manual: 'Added by staff',
  };
  return (
    <Card className="settings-section">
      <h2>Blocked addresses</h2>
      <p>TipMe doesn’t email addresses that bounce or complain.</p>
      <form className="settings-form" onSubmit={(e) => void lookup(e)}>
        <InputField
          id={`${id}-address`}
          type="email"
          label="Email address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          maxLength={254}
          required
        />
        <Button type="submit" variant="secondary">
          Look up
        </Button>
      </form>
      {found === null && <p>This address isn’t blocked.</p>}
      {found && (
        <>
          <p>
            {REASONS[found.reason] ?? found.reason} ({when(found.createdAt)}).
          </p>
          {canManage && (
            <ReasonAction
              open="Unblock"
              field="Why unblock this address?"
              submit={
                found.reason === 'complaint'
                  ? 'Unblock even though they complained'
                  : 'Unblock address'
              }
              onSubmit={async (reason) => {
                const result = await opsFetch(
                  '/v1/ops/providers/suppressions/remove',
                  {
                    method: 'POST',
                    body: {
                      address,
                      reason,
                      confirmComplaint: found.reason === 'complaint',
                    },
                  },
                );
                if (result.ok) {
                  setFound(null);
                  return null;
                }
                return 'That didn’t go through. Please try again.';
              }}
            />
          )}
        </>
      )}
    </Card>
  );
}

export default function ProvidersPage() {
  const access = useOpsAccess();
  const [data, setData] = useState<OpsMailProviders | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    void opsFetch<OpsMailProviders>('/v1/ops/providers/mail').then((result) => {
      if (result.ok) setData(result.data);
      else setFailed(true);
    });
  }, [version]);
  const refresh = () => setVersion((v) => v + 1);
  // A test moves on its own (sent, retried, failed), and so does a resting provider (trial,
  // recovered): follow them while one is waiting.
  const waiting = data?.providers.some(
    (p) =>
      p.lastTest?.status === 'pending' ||
      (p.health !== null && p.health.state !== 'healthy'),
  );
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setVersion((v) => v + 1), 5000);
    return () => clearInterval(timer);
  }, [waiting]);
  const canManage = can(access, 'providers.manage');
  return (
    <div className="ops-page-body">
      <h1>Providers</h1>
      <p>
        Which service sends TipMe’s email. A provider must pass a test before it
        can become active: staff send a test email and open its link, which
        proves mail really arrives.
      </p>
      {failed && (
        <Slip dense tone="error" title="Couldn’t load providers">
          Please refresh the page.
        </Slip>
      )}
      {!data && !failed && <Skeleton />}
      {data && (
        <>
          {data.changedAt && (
            <p>
              Last switched {when(data.changedAt)}: {data.reason}
            </p>
          )}
          <Failover data={data} canManage={canManage} onChange={refresh} />
          {data.providers.map((card) => (
            <ProviderCard
              key={card.name}
              card={card}
              canManage={canManage}
              onChange={refresh}
            />
          ))}
          <Overrides data={data} canManage={canManage} onChange={refresh} />
          {can(access, 'private.view') && (
            <Suppressions canManage={canManage} />
          )}
        </>
      )}
    </div>
  );
}
