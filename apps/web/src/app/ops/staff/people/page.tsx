'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  OPS_CATALOGUE,
  type OpsEffectiveAccess,
  type OpsEnrolmentLinkSent,
  type OpsPermission,
  type OpsRole,
  type OpsStaffAdded,
  type OpsStaffPerson,
} from '@tipme/contracts';
import {
  Badge,
  Button,
  InputField,
  Notice,
  Skeleton,
  TextareaField,
} from '@tipme/ui';
import {
  ActionOutcome,
  outcomeOf,
  type ActionOutcomeState,
} from '@/components/ops/action-outcome';
import { PermissionPicker } from '@/components/ops/permission-picker';
import { ReasonAction } from '@/components/ops/reason-action';
import { WaitingRequests } from '@/components/ops/waiting-requests';
import { can, useOpsAccess, when } from '@/lib/ops-client';
import {
  accessAdjustments,
  outcomeIsUnknown,
  refusalWords,
} from '@/lib/ops-answers';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

const sensitiveIn = (permissions: readonly string[]) =>
  permissions.filter((p) => OPS_CATALOGUE[p as OpsPermission]?.sensitive);

const inviteWords = (
  delivery: 'queued' | 'suppressed',
  expiresAt: string,
): string =>
  delivery === 'suppressed'
    ? 'That address is known not to accept mail, so the link won’t arrive. Fix it with their provider, then resend.'
    : `The link is on its way and works until ${when(expiresAt)}.`;

/** Done, but a link that won't arrive is not a success to tick. */
const sentOutcome = (
  answer: { kind: 'done'; actedAlone: boolean },
  link: { delivery: 'queued' | 'suppressed'; enrolmentExpiresAt: string },
  lead: string,
  title?: string,
): ActionOutcomeState => {
  const suppressed = link.delivery === 'suppressed';
  return {
    kind: 'done',
    actedAlone: answer.actedAlone,
    text: `${lead}${inviteWords(link.delivery, link.enrolmentExpiresAt)}`,
    ...(suppressed
      ? { warning: true, title: 'The link won’t arrive' }
      : title
        ? { title }
        : {}),
  };
};

function AddPerson({
  roles,
  onOutcome,
}: {
  roles: OpsRole[];
  onOutcome: (outcome: ActionOutcomeState) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [roleId, setRoleId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const role = roles.find((r) => r.id === roleId);
  const sensitive = role ? sensitiveIn(role.permissions) : [];
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    const answer = await opsAct<OpsStaffAdded>('/v1/ops/staff', {
      method: 'POST',
      body: {
        email: String(data.get('email') ?? '').trim(),
        roleId,
        reason: String(data.get('reason') ?? '').trim(),
      },
    });
    setBusy(false);
    if (answer.kind === 'refused') {
      setError(refusalWords(answer));
      return;
    }
    onOutcome(
      answer.kind === 'done'
        ? sentOutcome(answer, answer.data, '', 'Invitation sent')
        : outcomeOf(answer, ''),
    );
    setOpen(false);
  };
  if (!open)
    return <Button onClick={() => setOpen(true)}>Add a person…</Button>;
  return (
    <form className="settings-form" onSubmit={(e) => void submit(e)}>
      <InputField
        id={`${id}-email`}
        name="email"
        type="email"
        label="Their email"
        hint="They get a link. They sign in with an emailed code, then set up an authenticator. An address already on a recipient account uses that account."
        maxLength={254}
        required
        autoFocus
      />
      <div className="tm-field">
        <label htmlFor={`${id}-role`}>Role</label>
        <select
          id={`${id}-role`}
          className="tm-input"
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          required
        >
          <option value="" disabled>
            Choose a role
          </option>
          {roles
            .filter((r) => r.id !== 'release_check')
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      </div>
      {sensitive.length > 0 && (
        <Notice tone="neutral" title="This role holds sensitive access">
          {sensitive.join(', ')}. When someone else can approve, adding them
          waits for that person.
        </Notice>
      )}
      <TextareaField
        id={`${id}-reason`}
        name="reason"
        label="Why are you adding them?"
        hint="Recorded in the audit log with your name and the time."
        minLength={10}
        maxLength={500}
        required
      />
      {error && (
        <Notice tone="error" title="Not added">
          {error}
        </Notice>
      )}
      <div className="ops-actions">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Add person
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ChangeRole({
  person,
  roles,
  onOutcome,
  onUnknown,
}: {
  person: OpsStaffPerson;
  roles: OpsRole[];
  onOutcome: (outcome: ActionOutcomeState) => void;
  onUnknown: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [roleId, setRoleId] = useState(person.roleId);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(
      new FormData(event.currentTarget).get('reason') ?? '',
    );
    setBusy(true);
    setError('');
    const answer = await opsAct<OpsEffectiveAccess>(
      `/v1/ops/staff/${person.userId}/role`,
      { method: 'PUT', body: { roleId, reason: reason.trim() } },
    );
    setBusy(false);
    if (answer.kind === 'refused') {
      if (outcomeIsUnknown(answer)) onUnknown();
      return setError(refusalWords(answer));
    }
    onOutcome(outcomeOf(answer, 'Their role is changed.'));
    setOpen(false);
  };
  if (!open)
    return (
      <Button
        variant="secondary"
        onClick={() => {
          setRoleId(person.roleId);
          setOpen(true);
        }}
      >
        Change role…
      </Button>
    );
  return (
    <form className="ops-reason" onSubmit={(e) => void submit(e)}>
      <div className="tm-field">
        <label htmlFor={`${id}-role`}>New role</label>
        <select
          id={`${id}-role`}
          className="tm-input"
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          autoFocus
        >
          {roles
            .filter((r) => r.id !== 'release_check')
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      </div>
      <TextareaField
        id={`${id}-reason`}
        name="reason"
        label="Why change their role?"
        hint={
          roleId === 'owner'
            ? 'An owner holds everything, so their personal adjustments are cleared. Recorded in the audit log.'
            : 'Their personal adjustments stay. Recorded in the audit log.'
        }
        minLength={10}
        maxLength={500}
        required
      />
      {error && (
        <Notice tone="error" title="Not changed">
          {error}
        </Notice>
      )}
      <div className="ops-actions">
        <Button
          type="submit"
          disabled={busy || roleId === person.roleId}
          aria-busy={busy}
        >
          Change role
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AdjustAccess({
  person,
  rolePermissions: fromRole,
  held,
  onOutcome,
  onUnknown,
}: {
  person: OpsStaffPerson;
  rolePermissions: string[];
  held: string[];
  onOutcome: (outcome: ActionOutcomeState) => void;
  onUnknown: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState(person.permissions);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(
      new FormData(event.currentTarget).get('reason') ?? '',
    );
    setBusy(true);
    setError('');
    const answer = await opsAct<OpsEffectiveAccess>(
      `/v1/ops/staff/${person.userId}/access`,
      {
        method: 'PUT',
        body: { ...accessAdjustments(fromRole, ticked), reason: reason.trim() },
      },
    );
    setBusy(false);
    if (answer.kind === 'refused') {
      if (outcomeIsUnknown(answer)) onUnknown();
      return setError(refusalWords(answer));
    }
    onOutcome(outcomeOf(answer, 'Their access is changed.'));
    setOpen(false);
  };
  if (!open)
    return (
      <Button
        variant="secondary"
        onClick={() => {
          setTicked(person.permissions);
          setOpen(true);
        }}
      >
        Adjust access…
      </Button>
    );
  return (
    <form className="settings-form" onSubmit={(e) => void submit(e)}>
      <PermissionPicker
        ticked={ticked}
        onChange={setTicked}
        held={held}
        differs={(p) =>
          ticked.includes(p) && !fromRole.includes(p)
            ? '(beyond their role)'
            : !ticked.includes(p) && fromRole.includes(p)
              ? '(taken from their role)'
              : null
        }
      />
      <TextareaField
        id={`${id}-reason`}
        name="reason"
        label="Why adjust their access?"
        hint="Takes effect on their next request. Recorded in the audit log."
        minLength={10}
        maxLength={500}
        required
      />
      {error && (
        <Notice tone="error" title="Not changed">
          {error}
        </Notice>
      )}
      <div className="ops-actions">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Save access
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Person({
  person,
  roles,
  held,
  mayReset,
  onChanged,
  onRemoved,
}: {
  person: OpsStaffPerson;
  roles: OpsRole[] | null;
  held: string[];
  mayReset: boolean;
  onChanged: () => void;
  onRemoved: (text: string) => void;
}) {
  const id = useId();
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const hear = (next: ActionOutcomeState) => {
    setOutcome(next);
    onChanged();
  };
  const name = person.email ?? 'No email on the account';
  // Without the role's own list, ticks can't be turned into what differs from it.
  const rolePermissions = roles?.find(
    (r) => r.id === person.roleId,
  )?.permissions;
  const roleKnown = rolePermissions !== undefined;
  return (
    <article aria-labelledby={id} className="ops-row">
      <div className="ops-row__head">
        <h3 id={id}>{name}</h3>
        <Badge>{person.roleName}</Badge>
        <Badge>
          {person.enrolled
            ? 'Set up'
            : person.invitation?.linkOpen
              ? 'Invited'
              : 'Invitation expired'}
        </Badge>
      </div>
      <p className="tm-hint">
        On staff since {when(person.grantedAt)} · {person.permissions.length}{' '}
        permissions
      </p>
      {person.additions.length > 0 && (
        <p>Added beyond their role: {person.additions.join(', ')}</p>
      )}
      {person.removals.length > 0 && (
        <p>Taken away from their role: {person.removals.join(', ')}</p>
      )}
      {outcome && <ActionOutcome outcome={outcome} />}
      <div className="ops-actions">
        {roleKnown ? (
          <>
            <ChangeRole
              person={person}
              roles={roles!}
              onOutcome={hear}
              onUnknown={onChanged}
            />
            <AdjustAccess
              person={person}
              rolePermissions={rolePermissions!}
              held={held}
              onOutcome={hear}
              onUnknown={onChanged}
            />
          </>
        ) : (
          <p className="tm-hint">
            Couldn’t read the roles, so role and access changes wait until they
            load.
          </p>
        )}
        {person.enrolled ? (
          // Owners only, on the server too: anyone else would only be refused.
          mayReset && (
            <ReasonAction
              open="Reset authenticator…"
              field="Why reset their authenticator?"
              hint="For a lost phone. They get a new link by email. Recorded in the audit log."
              submit="Reset authenticator"
              onSubmit={async (reason) => {
                const answer = await opsAct<OpsEnrolmentLinkSent>(
                  `/v1/ops/staff/${person.userId}/reset-authenticator`,
                  { method: 'POST', body: { reason } },
                );
                if (answer.kind === 'refused') return refusalWords(answer);
                hear(
                  answer.kind === 'done'
                    ? sentOutcome(
                        answer,
                        answer.data,
                        'Their authenticator is reset. ',
                      )
                    : outcomeOf(answer, ''),
                );
                return null;
              }}
            />
          )
        ) : (
          <ReasonAction
            open="Resend invitation…"
            field="Why resend it?"
            submit="Resend invitation"
            onSubmit={async (reason) => {
              const result = await opsFetch<OpsEnrolmentLinkSent>(
                `/v1/ops/staff/${person.userId}/resend-invitation`,
                { method: 'POST', body: { reason } },
              );
              if (!result.ok) return refusalWords(result);
              hear(
                sentOutcome(
                  { kind: 'done', actedAlone: false },
                  result.data,
                  '',
                ),
              );
              return null;
            }}
          />
        )}
        <ReasonAction
          open="Remove…"
          field="Why remove them?"
          hint="Takes effect at once and ends their admin sessions. The audit trail stays."
          submit="Remove from staff"
          onSubmit={async (reason) => {
            const result = await opsFetch(
              `/v1/ops/staff/${person.userId}/remove`,
              { method: 'POST', body: { reason } },
            );
            if (!result.ok) {
              if (outcomeIsUnknown(result)) onChanged();
              return refusalWords(result);
            }
            onRemoved(`${name} is off staff, and their admin sessions ended.`);
            return null;
          }}
        />
      </div>
    </article>
  );
}

/** Who is on staff and what they can do. Everything here is re-checked by the server. */
export default function PeoplePage() {
  const access = useOpsAccess();
  const [people, setPeople] = useState<OpsStaffPerson[] | null>(null);
  const [roles, setRoles] = useState<OpsRole[] | null>(null);
  const [problem, setProblem] = useState('');
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const [refresh, setRefresh] = useState(0);
  const allowed = can(access, 'staff.manage');

  const load = useCallback(async () => {
    const [list, roleList] = await Promise.all([
      opsFetch<OpsStaffPerson[]>('/v1/ops/staff'),
      opsFetch<OpsRole[]>('/v1/ops/staff/roles'),
    ]);
    setRoles(roleList.ok ? roleList.data : null);
    if (list.ok) {
      setPeople(list.data);
      setProblem('');
    } else setProblem(refusalWords(list));
    setRefresh((n) => n + 1);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing is set before the await
    if (allowed) void load();
  }, [allowed, load]);

  if (!allowed)
    return (
      <Notice tone="neutral" title="Not part of your role">
        Managing people needs the “staff.manage” permission.
      </Notice>
    );
  return (
    <div className="ops-dashboard">
      <h1>People</h1>
      <p className="tm-hint">
        Effective access is the role’s permissions, plus additions, minus
        removals. You can’t give what you don’t hold, or change your own access.
      </p>
      {outcome && <ActionOutcome outcome={outcome} />}
      <WaitingRequests
        title="Staff changes waiting"
        permission="staff.manage"
        refresh={refresh}
      />
      {roles && (
        <AddPerson
          roles={roles}
          onOutcome={(next) => {
            setOutcome(next);
            void load();
          }}
        />
      )}
      {problem && (
        <Notice tone="error" title="Couldn’t load the people">
          {problem}{' '}
          <Button variant="quiet" onClick={() => void load()}>
            Try again
          </Button>
        </Notice>
      )}
      {!people && !problem && <Skeleton label="Loading the people" />}
      {people && (
        <div className="ops-list">
          {people.map((person) => (
            <Person
              key={person.userId}
              person={person}
              roles={roles}
              held={access.permissions}
              mayReset={access.role === 'owner'}
              onChanged={() => void load()}
              onRemoved={(text) => {
                setOutcome({ kind: 'done', actedAlone: false, text });
                void load();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
