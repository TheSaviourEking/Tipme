'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { OpsRole, OpsRoleImpact, OpsRoleUpdated } from '@tipme/contracts';
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
import { can, useOpsAccess } from '@/lib/ops-client';
import { refusalWords } from '@/lib/ops-answers';
import { opsAct, opsFetch } from '@/lib/ops-staff-api';

function NewRole({
  held,
  onDone,
}: {
  held: string[];
  onDone: (outcome: ActionOutcomeState) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    const result = await opsFetch<OpsRole>('/v1/ops/staff/roles', {
      method: 'POST',
      body: {
        name: String(data.get('name') ?? '').trim(),
        description: String(data.get('description') ?? '').trim(),
        permissions: ticked,
        reason: String(data.get('reason') ?? '').trim(),
      },
    });
    setBusy(false);
    if (!result.ok) return setError(refusalWords(result));
    onDone({
      kind: 'done',
      actedAlone: false,
      text: 'The role is created. Nobody holds it until you give it to them.',
    });
    setOpen(false);
    setTicked([]);
  };
  if (!open) return <Button onClick={() => setOpen(true)}>New role…</Button>;
  return (
    <form className="settings-form" onSubmit={(e) => void submit(e)}>
      <InputField
        id={`${id}-name`}
        name="name"
        label="Role name"
        maxLength={60}
        required
        autoFocus
      />
      <InputField
        id={`${id}-description`}
        name="description"
        label="What is it for? (optional)"
        maxLength={200}
      />
      <PermissionPicker ticked={ticked} onChange={setTicked} held={held} />
      <TextareaField
        id={`${id}-reason`}
        name="reason"
        label="Why this role?"
        hint="Recorded in the audit log with your name and the time."
        minLength={10}
        maxLength={500}
        required
      />
      {error && (
        <Notice tone="error" title="Not created">
          {error}
        </Notice>
      )}
      <div className="ops-actions">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          Create role
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Role({
  role,
  held,
  onChanged,
}: {
  role: OpsRole;
  held: string[];
  onChanged: () => void;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [ticked, setTicked] = useState(role.permissions);
  const [impact, setImpact] = useState<OpsRoleImpact | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const review = async () => {
    setBusy(true);
    setError('');
    const result = await opsFetch<OpsRoleImpact>(
      `/v1/ops/staff/roles/${encodeURIComponent(role.id)}/impact`,
      { method: 'POST', body: { permissions: ticked } },
    );
    setBusy(false);
    if (result.ok) setImpact(result.data);
    else setError(refusalWords(result));
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(
      new FormData(event.currentTarget).get('reason') ?? '',
    );
    setBusy(true);
    setError('');
    const answer = await opsAct<OpsRoleUpdated>(
      `/v1/ops/staff/roles/${encodeURIComponent(role.id)}`,
      { method: 'PATCH', body: { permissions: ticked, reason: reason.trim() } },
    );
    setBusy(false);
    if (answer.kind === 'refused') return setError(refusalWords(answer));
    setOutcome(
      answer.kind === 'done'
        ? ({
            ...outcomeOf(
              answer,
              'The role is saved, for everyone holding it, from their next request.',
            ),
            title: 'The role is saved',
          } as ActionOutcomeState)
        : outcomeOf(answer, ''),
    );
    setEditing(false);
    setImpact(null);
    onChanged();
  };

  return (
    <article aria-labelledby={id} className="ops-row">
      <div className="ops-row__head">
        <h3 id={id}>{role.name}</h3>
        {role.system && <Badge>Built in</Badge>}
      </div>
      {role.description && <p>{role.description}</p>}
      <p className="tm-hint">
        {role.people} {role.people === 1 ? 'person' : 'people'} ·{' '}
        {role.permissions.length} permissions
      </p>
      {outcome && <ActionOutcome outcome={outcome} />}
      {role.system ? (
        <p className="tm-hint">Built-in roles can’t be edited or deleted.</p>
      ) : editing ? (
        <div className="settings-form">
          <PermissionPicker
            ticked={ticked}
            onChange={(next) => {
              setTicked(next);
              setImpact(null);
            }}
            held={held}
          />
          {!impact && (
            <div className="ops-actions">
              <Button
                disabled={busy}
                aria-busy={busy}
                onClick={() => void review()}
              >
                Review who is affected
              </Button>
              <Button variant="quiet" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          )}
          {impact && (
            <form className="settings-form" onSubmit={(e) => void save(e)}>
              <div role="status">
                {impact.affected.length === 0 ? (
                  <p>Nobody’s access changes.</p>
                ) : (
                  <>
                    <p>
                      <strong>This changes access for:</strong>
                    </p>
                    <ul className="ops-permissions">
                      {impact.affected.map((person) => (
                        <li key={person.userId}>
                          <span>
                            {person.email ?? 'A person with no email'}
                          </span>
                          {person.gains.length > 0 && (
                            <span>Gains: {person.gains.join(', ')}</span>
                          )}
                          {person.losses.length > 0 && (
                            <span>Loses: {person.losses.join(', ')}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
              <TextareaField
                id={`${id}-reason`}
                name="reason"
                label="Why change this role?"
                hint="Recorded in the audit log with your name and the time."
                minLength={10}
                maxLength={500}
                required
              />
              <div className="ops-actions">
                <Button type="submit" disabled={busy} aria-busy={busy}>
                  Save role
                </Button>
                <Button variant="quiet" onClick={() => setImpact(null)}>
                  Back
                </Button>
              </div>
            </form>
          )}
          {error && (
            <Notice tone="error" title="Not saved">
              {error}
            </Notice>
          )}
        </div>
      ) : (
        <div className="ops-actions">
          <Button
            variant="secondary"
            onClick={() => {
              setTicked(role.permissions);
              setEditing(true);
            }}
          >
            Edit…
          </Button>
          {role.people > 0 ? (
            <p className="tm-hint">Move everyone off this role to delete it.</p>
          ) : (
            <ReasonAction
              open="Delete…"
              field="Why delete this role?"
              submit="Delete role"
              onSubmit={async (reason) => {
                const result = await opsFetch(
                  `/v1/ops/staff/roles/${encodeURIComponent(role.id)}/delete`,
                  { method: 'POST', body: { reason } },
                );
                if (!result.ok) return refusalWords(result);
                onChanged();
                return null;
              }}
            />
          )}
        </div>
      )}
    </article>
  );
}

/** Sets of permissions, by name. Editing one affects everyone holding it. */
export default function RolesPage() {
  const access = useOpsAccess();
  const [roles, setRoles] = useState<OpsRole[] | null>(null);
  const [problem, setProblem] = useState('');
  const [outcome, setOutcome] = useState<ActionOutcomeState | null>(null);
  const [refresh, setRefresh] = useState(0);
  const allowed = can(access, 'staff.manage');
  const load = useCallback(async () => {
    const result = await opsFetch<OpsRole[]>('/v1/ops/staff/roles');
    if (result.ok) {
      setRoles(result.data);
      setProblem('');
    } else setProblem(refusalWords(result));
    setRefresh((n) => n + 1);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing is set before the await
    if (allowed) void load();
  }, [allowed, load]);
  if (!allowed)
    return (
      <Notice tone="neutral" title="Not part of your role">
        Managing roles needs the “staff.manage” permission.
      </Notice>
    );
  return (
    <div className="ops-dashboard">
      <h1>Roles</h1>
      <p className="tm-hint">
        A new role starts with nothing ticked. A role can’t be deleted while
        anyone has it.
      </p>
      {outcome && <ActionOutcome outcome={outcome} />}
      <WaitingRequests
        title="Role changes waiting"
        permission="staff.manage"
        refresh={refresh}
      />
      <NewRole
        held={access.permissions}
        onDone={(next) => {
          setOutcome(next);
          void load();
        }}
      />
      {problem && (
        <Notice tone="error" title="Couldn’t load the roles">
          {problem}
        </Notice>
      )}
      {!roles && !problem && <Skeleton label="Loading the roles" />}
      {roles && (
        <div className="ops-list">
          {roles.map((role) => (
            <Role
              key={role.id}
              role={role}
              held={access.permissions}
              onChanged={() => void load()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
