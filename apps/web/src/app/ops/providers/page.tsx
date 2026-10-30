'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { OpsMailProviderCard, OpsMailProviders } from '@tipme/contracts';
import {
  Button,
  Card,
  InputField,
  Notice,
  Skeleton,
  TextareaField,
} from '@tipme/ui';
import { ReasonAction } from '@/components/ops/reason-action';
import { can, useOpsAccess, when } from '@/lib/ops-client';
import { apiFetch } from '@/lib/session-client';

const TEST_STATUS: Record<string, string> = {
  pending: 'Waiting for the link in the email to be opened',
  confirmed: 'Confirmed',
  failed: 'Failed',
  expired: 'Expired',
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
  const test = card.lastTest;
  const sendTest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const to = String(data.get('to') ?? '').trim();
    const reason = String(data.get('reason') ?? '').trim();
    const result = await apiFetch(`/v1/ops/providers/mail/${card.name}/test`, {
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
      {card.active && (
        <p>
          <strong>Active</strong>
        </p>
      )}
      {card.sandbox === true && (
        <Notice tone="neutral" title="Sandbox">
          This provider only delivers to verified recipients
          {card.statusDetail ? ` (${card.statusDetail})` : ''}. It can’t be made
          active in production.
        </Notice>
      )}
      <p>
        Last 24 hours: {card.last24h.sent} sent, {card.last24h.failed} failed
        attempts, {card.last24h.bounced} bounced, {card.last24h.complained}{' '}
        complaints.
      </p>
      {test ? (
        <p>
          {test.status === 'pending'
            ? `Test sent to ${test.targetHint ?? 'staff'} ${when(test.startedAt)}. `
            : ''}
          {TEST_STATUS[test.status]}
          {test.confirmedAt ? ` ${when(test.confirmedAt)}` : ''}.
          {test.messageStatus === 'failed' &&
            ` The email failed${test.failureCode ? `: ${test.failureCode}` : ''}.`}
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
                <Notice tone="error" title="Not sent">
                  {error}
                </Notice>
              )}
              <Button type="submit">Send the test email</Button>
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
                  const result = await apiFetch(
                    '/v1/ops/providers/mail/active',
                    {
                      method: 'POST',
                      body: { provider: card.name, reason },
                    },
                  );
                  if (result.ok) {
                    onChange();
                    return null;
                  }
                  return result.code === 'PROVIDER_NOT_ALLOWED'
                    ? 'This provider can’t be made active in production.'
                    : 'The switch didn’t go through. Please try again.';
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
    const result = await apiFetch('/v1/ops/providers/overrides', {
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
          ? 'No account with that handle or id, or that provider isn’t configured.'
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
                    const result = await apiFetch(
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
            label="Account (handle or user id)"
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
            <Notice tone="error" title="Not saved">
              {error}
            </Notice>
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
    const result = await apiFetch<{
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
                const result = await apiFetch(
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
    void apiFetch<OpsMailProviders>('/v1/ops/providers/mail').then((result) => {
      if (result.ok) setData(result.data);
      else setFailed(true);
    });
  }, [version]);
  const refresh = () => setVersion((v) => v + 1);
  const canManage = can(access, 'providers.manage');
  return (
    <>
      <h1>Providers</h1>
      <p>
        Which service sends TipMe’s email. A provider must pass a test before it
        can become active: staff send a test email and open its link, which
        proves mail really arrives.
      </p>
      {failed && (
        <Notice tone="error" title="Couldn’t load providers">
          Please refresh the page.
        </Notice>
      )}
      {!data && !failed && <Skeleton />}
      {data && (
        <>
          {data.changedAt && (
            <p>
              Last switched {when(data.changedAt)}: {data.reason}
            </p>
          )}
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
    </>
  );
}
