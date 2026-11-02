import {
  OPS_CATALOGUE,
  type OpsIssueOutcome,
  type OpsPermission,
} from '@tipme/contracts';
import type { MailProviderName } from '@tipme/mail';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  issues,
  profiles,
  providerSettings,
  roles,
  staff,
  users,
} from '../schema.js';
import { maskEmail, normaliseEmail } from './email-address.js';
import { startStaffRecovery } from './email-recovery.js';
import { guarded, OperationError } from './errors.js';
import { grantFeeFreeTips, setAccountFee } from './fees.js';
import { resolveIssue } from './issues.js';
import {
  applyAfterRead,
  markFailedAfterRead,
  payoutCaseFacts,
  readPayoutForAction,
  refuseToApply,
  refuseToMarkFailed,
  withCurrentCase,
  type PreparedPayoutRead,
} from './payout-staff.js';
import { hasConfirmedMailTest, switchMailProvider } from './provider-admin.js';
import {
  registerSeriousAction,
  requestSeriousAction,
  type SeriousActionCheck,
  type SeriousActionDefinition,
  type SeriousActionOutcome,
  type SeriousActionServices,
} from './serious-actions.js';
import {
  addStaff,
  changeRole,
  resetAuthenticator,
  setPersonalAccess,
  updateRole,
} from './staff-admin.js';
import {
  lockStaffAdmin,
  readOverrides,
  readRolePermissions,
  readStaffAccess,
  whileHoldingStaffAdmin,
} from './staff.js';

/*
 * The real serious actions. Each action's work is one function, `act`, used for the check at asking
 * and for the run. It only waits on the transaction it is given (ruling N1): queued mail is a row in
 * it, and a provider's answer comes from `prepare`, before the transaction. Loaded by the API and the
 * worker, as a pending request's mail depends on who may decide. Nothing runs at import.
 */

const isSensitive = (permission: string): boolean =>
  OPS_CATALOGUE[permission as OpsPermission]?.sensitive === true;

function servicesOf(check: { services?: SeriousActionServices | undefined }) {
  if (!check.services) throw new OperationError('INVALID_INPUT');
  return check.services;
}

class DryRunDone extends Error {}

/**
 * Whether it would go through, by doing it and undoing it: the same checks as the run, so a request
 * that could never pass isn't left waiting on someone.
 */
async function dryRun(
  tx: Tx,
  work: (savepoint: Tx) => Promise<unknown>,
): Promise<void> {
  try {
    await tx.transaction(async (savepoint) => {
      await work(savepoint);
      throw new DryRunDone();
    });
  } catch (error) {
    if (!(error instanceof DryRunDone)) throw error;
  }
}

/** An action whose check is a dry run of its work. */
function acting<Payload>(
  definition: Omit<SeriousActionDefinition<Payload>, 'validate' | 'run'> & {
    act(
      tx: Tx,
      payload: Payload,
      context: SeriousActionCheck & { approverId?: string | null },
    ): Promise<unknown>;
  },
): SeriousActionDefinition<Payload> {
  const { act, ...rest } = definition;
  return {
    ...rest,
    validate: (tx, payload, check) =>
      dryRun(tx, (savepoint) => act(savepoint, payload, check)),
    run: (tx, payload, context) => act(tx, payload, context),
  };
}

const pageOwner = async (db: Database | Tx, profileId: string) => {
  const [page] = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  return page?.userId ? [page.userId] : [];
};

const handleOf = async (db: Database | Tx, profileId: string) => {
  const [page] = await db
    .select({ handle: profiles.handle })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  if (!page) throw new OperationError('PROFILE_NOT_FOUND');
  return page.handle;
};

const personHint = async (db: Database | Tx, userId: string) => {
  const [person] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return person?.email ? maskEmail(person.email) : 'a staff member';
};

/** Who an address already belongs to: they are who a grant by address would benefit. */
const accountOfEmail = async (db: Database | Tx, email: string) => {
  const [person] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
  return person ? [person.id] : [];
};

const isOwner = (approver: { access: { roleId: string } }) =>
  approver.access.roleId === 'owner';

const roleStamp = async (db: Database | Tx, roleId: string) => {
  const [role] = await db
    .select({ at: sql<string>`${roles.updatedAt}::text` })
    .from(roles)
    .where(eq(roles.id, roleId));
  if (!role) throw new OperationError('ROLE_NOT_FOUND');
  return role.at;
};

const roleName = async (db: Database | Tx, roleId: string) => {
  const [role] = await db
    .select({ name: roles.name })
    .from(roles)
    .where(eq(roles.id, roleId));
  if (!role) throw new OperationError('ROLE_NOT_FOUND');
  return role.name;
};

/* Email recovery */

interface RecoveryPayload {
  userId: string;
  newEmail: string;
  checks: string;
}

const emailRecovery = acting<RecoveryPayload>({
  name: 'email_recovery.start',
  permission: 'recoveries.manage',
  subjects: ({ userId }) => [userId],
  target: ({ userId }) => userId,
  describe: async (tx, { userId, newEmail }) =>
    `Move ${await personHint(tx, userId)} to the email address ${maskEmail(newEmail)}`,
  act: async (tx, payload, context) => {
    const outcome = await startStaffRecovery(tx, servicesOf(context).sealing, {
      staffUserId: context.actorId,
      userId: payload.userId,
      newEmail: payload.newEmail,
      checks: payload.checks,
      reason: context.reason,
      secret: servicesOf(context).authCodeSecret,
      now: context.now,
    });
    if (outcome === 'not_found') throw new OperationError('APPROVAL_NOT_FOUND');
    if (outcome === 'staff_account')
      throw new OperationError('RECOVERY_STAFF_ACCOUNT');
    if (outcome === 'invalid') throw new OperationError('INVALID_INPUT');
    return { outcome };
  },
});

/* Money */

type SettlePayload =
  | { issueId: string; how: 'apply'; reported: 'paid' | 'failed' }
  | { issueId: string; how: 'mark_failed' };

const settleInput = (
  payload: SettlePayload,
  context: SeriousActionCheck,
  provider: NonNullable<SeriousActionServices['payoutReader']>,
) => ({
  issueId: payload.issueId,
  staffUserId: context.actorId,
  provider,
  reason: context.reason,
  now: context.now,
});

const noReads = () => {
  // The answer was read in `prepare`. Reading from here would wait on a provider inside the lock.
  throw new OperationError('INVALID_INPUT');
};

const payoutSettle = acting<SettlePayload>({
  name: 'payout.settle',
  permission: 'payouts.resolve',
  prepare: (db, payload, { actorId, services }) => {
    const provider = servicesOf({ services }).payoutReader;
    if (!provider) throw new OperationError('INVALID_INPUT');
    return readPayoutForAction(db, {
      issueId: payload.issueId,
      staffUserId: actorId,
      provider,
      ...(services?.payoutLog ? { log: services.payoutLog } : {}),
    });
  },
  subjects: async ({ issueId }, db) => {
    const facts = await payoutCaseFacts(db, issueId);
    return facts ? pageOwner(db, facts.profileId) : [];
  },
  target: ({ issueId }) => issueId,
  current: async (tx, { issueId }) =>
    (await payoutCaseFacts(tx, issueId))?.status ?? null,
  describe: async (tx, payload) => {
    const facts = await payoutCaseFacts(tx, payload.issueId);
    if (!facts) throw new OperationError('ISSUE_NOT_FOUND');
    const end = facts.payoutId.slice(-6);
    return payload.how === 'apply'
      ? `Record withdrawal ending ${end} as ${payload.reported}, as the payment provider reports`
      : `Mark withdrawal ending ${end} failed: the payment provider has no such payout, so its money is released`;
  },
  act: async (tx, payload, context) => {
    const input = settleInput(payload, context, noReads);
    const prepared = await withCurrentCase(
      tx,
      input,
      context.facts as PreparedPayoutRead,
    );
    const refusal =
      payload.how === 'apply'
        ? await refuseToApply(
            tx,
            { ...input, reported: payload.reported },
            prepared,
          )
        : await refuseToMarkFailed(tx, input, prepared);
    if (refusal) {
      // A second person agreed to the change, not to a refusal: the request closes as stale.
      if (context.approverId)
        throw new OperationError('STAFF_CHANGED', `payout_${refusal.outcome}`);
      return refusal;
    }
    return payload.how === 'apply'
      ? applyAfterRead(tx, { ...input, reported: payload.reported }, prepared)
      : markFailedAfterRead(tx, input, prepared);
  },
});

/** Only `written_off`: the other outcomes record what happened, and this gives money up. */
const WRITE_OFF: OpsIssueOutcome = 'written_off';

const balanceWriteOff = acting<{ issueId: string }>({
  name: 'balance.write_off',
  permission: 'payouts.resolve',
  // The route asks for this too: closing an issue takes it.
  mayDecide: async (_db, _payload, approver) =>
    approver.access.permissions.has('issues.resolve'),
  subjects: async ({ issueId }, db) => {
    const [issue] = await db
      .select({ subject: issues.subject })
      .from(issues)
      .where(eq(issues.id, issueId));
    const { profileId, userId } = issue?.subject ?? {};
    return [
      ...(userId ? [userId] : []),
      ...(profileId ? await pageOwner(db, profileId) : []),
    ];
  },
  target: ({ issueId }) => issueId,
  describe: async (tx, { issueId }) => {
    const [issue] = await tx
      .select({ kind: issues.kind })
      .from(issues)
      .where(eq(issues.id, issueId));
    if (!issue) throw new OperationError('ISSUE_NOT_FOUND');
    return `Close money issue ending ${issueId.slice(-6)} (${issue.kind}) as written off`;
  },
  act: async (tx, { issueId }, context) => {
    await resolveIssue(tx, {
      issueId,
      staffUserId: context.actorId,
      reason: context.reason,
      outcome: WRITE_OFF,
      now: context.now,
    });
    return { resolved: true };
  },
});

const feeChange = acting<{ profileId: string; feeBps: number | null }>({
  name: 'fee.change',
  permission: 'fees.manage',
  subjects: ({ profileId }, db) => pageOwner(db, profileId),
  target: ({ profileId }) => profileId,
  current: async (tx, { profileId }) => {
    const [page] = await tx
      .select({ feeBps: profiles.customFeeBps })
      .from(profiles)
      .where(eq(profiles.id, profileId));
    return page?.feeBps ?? null;
  },
  describe: async (tx, { profileId, feeBps }) =>
    `Set @${await handleOf(tx, profileId)}'s fee to ${
      feeBps === null ? 'the standard fee' : `${feeBps / 100}%`
    }`,
  act: (tx, { profileId, feeBps }, context) =>
    setAccountFee(tx, {
      staffUserId: context.actorId,
      profileId,
      feeBps,
      reason: context.reason,
    }).then(({ handle }) => ({ revalidateHandle: handle.toLowerCase() })),
});

const feeFree = acting<{ profileId: string; count: number }>({
  name: 'fee.free',
  permission: 'fees.manage',
  subjects: ({ profileId }, db) => pageOwner(db, profileId),
  target: ({ profileId }) => profileId,
  describe: async (tx, { profileId, count }) =>
    `Give @${await handleOf(tx, profileId)} ${count} fee-free tips`,
  act: (tx, { profileId, count }, context) =>
    grantFeeFreeTips(tx, {
      staffUserId: context.actorId,
      profileId,
      count,
      reason: context.reason,
    }),
});

/* Staff access */

export type GrantPayload =
  | { kind: 'add'; email: string; roleId: string }
  | { kind: 'role'; userId: string; roleId: string }
  | {
      kind: 'access';
      userId: string;
      additions: string[];
      removals: string[];
    };

const grantSubjects = (payload: GrantPayload, db: Database | Tx) =>
  payload.kind === 'add'
    ? accountOfEmail(db, payload.email)
    : Promise.resolve([payload.userId]);

const grantTarget = (payload: GrantPayload) =>
  payload.kind === 'add' ? `email:${payload.email}` : `user:${payload.userId}`;

const grantDescribe = async (tx: Tx, payload: GrantPayload) => {
  if (payload.kind === 'add')
    return `Add ${maskEmail(payload.email)} as staff with the role ${await roleName(tx, payload.roleId)}`;
  const who = await personHint(tx, payload.userId);
  if (payload.kind === 'role')
    return `Move ${who} to the role ${await roleName(tx, payload.roleId)}`;
  const list = (names: string[]) => (names.length ? names.join(', ') : 'none');
  return `Set ${who}'s personal access: adds ${list(payload.additions)}; removes ${list(payload.removals)}`;
};

/** The role a grant hands out moved, or the person's access did: the request stops. */
const grantCurrent = async (tx: Tx, payload: GrantPayload) => {
  if (payload.kind === 'add')
    return { role: await roleStamp(tx, payload.roleId) };
  const access = await readStaffAccess(tx, payload.userId);
  if (payload.kind === 'role')
    return {
      role: await roleStamp(tx, payload.roleId),
      from: access?.roleId ?? null,
    };
  const overrides = await readOverrides(tx, payload.userId);
  return {
    role: access ? await roleStamp(tx, access.roleId) : null,
    from: access?.roleId ?? null,
    overrides: overrides.map((row) => `${row.effect}:${row.permission}`).sort(),
  };
};

function grantAct(tx: Tx, payload: GrantPayload, context: SeriousActionCheck) {
  const { actorId, reason } = context;
  if (payload.kind === 'add')
    return addStaff(tx, {
      actorId,
      email: payload.email,
      roleId: payload.roleId,
      reason,
      sealing: servicesOf(context).sealing,
      now: context.now,
    });
  if (payload.kind === 'role')
    return changeRole(tx, {
      actorId,
      userId: payload.userId,
      roleId: payload.roleId,
      reason,
    });
  return setPersonalAccess(tx, {
    actorId,
    userId: payload.userId,
    additions: payload.additions,
    removals: payload.removals,
    reason,
  });
}

const grantOwnerAction = acting<GrantPayload>({
  name: 'staff.grant_owner',
  permission: 'staff.manage',
  mayDecide: async (_db, _payload, approver) => isOwner(approver),
  subjects: grantSubjects,
  target: grantTarget,
  current: grantCurrent,
  describe: grantDescribe,
  act: grantAct,
});

/** What the person would be given: someone who doesn't hold it all can't decide it. */
const permissionsGranted = async (db: Database | Tx, payload: GrantPayload) =>
  payload.kind === 'access'
    ? payload.additions
    : readRolePermissions(db, payload.roleId);

const grantSensitive = acting<GrantPayload>({
  name: 'staff.grant_sensitive',
  permission: 'staff.manage',
  mayDecide: async (db, payload, approver) =>
    (await permissionsGranted(db, payload)).every((permission) =>
      approver.access.permissions.has(permission),
    ),
  subjects: grantSubjects,
  target: grantTarget,
  current: grantCurrent,
  describe: grantDescribe,
  act: grantAct,
});

export interface RoleEditPayload {
  roleId: string;
  name?: string;
  description?: string;
  permissions: string[];
}

const addedBy = async (db: Database | Tx, payload: RoleEditPayload) => {
  const stored = new Set(await readRolePermissions(db, payload.roleId));
  return payload.permissions.filter((permission) => !stored.has(permission));
};

const roleAddSensitive = acting<RoleEditPayload>({
  name: 'role.add_sensitive',
  permission: 'staff.manage',
  mayDecide: async (db, payload, approver) =>
    (await addedBy(db, payload)).every((permission) =>
      approver.access.permissions.has(permission),
    ),
  // Everyone on the role gains it.
  subjects: async ({ roleId }, db) => {
    const people = await db
      .select({ userId: staff.userId })
      .from(staff)
      .where(and(eq(staff.roleId, roleId), isNull(staff.revokedAt)));
    return people.map((person) => person.userId);
  },
  target: ({ roleId }) => roleId,
  current: (tx, { roleId }) => roleStamp(tx, roleId),
  describe: async (tx, payload) =>
    `Add ${(await addedBy(tx, payload)).join(', ') || 'nothing'} to the role ${await roleName(tx, payload.roleId)}`,
  act: (tx, payload, context) =>
    updateRole(tx, {
      actorId: context.actorId,
      roleId: payload.roleId,
      reason: context.reason,
      permissions: payload.permissions,
      ...(payload.name === undefined ? {} : { name: payload.name }),
      ...(payload.description === undefined
        ? {}
        : { description: payload.description }),
    }),
});

const staffResetAuthenticator = acting<{ userId: string }>({
  name: 'staff.reset_authenticator',
  permission: 'staff.manage',
  mayDecide: async (_db, _payload, approver) => isOwner(approver),
  subjects: ({ userId }) => [userId],
  target: ({ userId }) => userId,
  describe: async (tx, { userId }) =>
    `Reset the authenticator of ${await personHint(tx, userId)} and email them a new link`,
  act: (tx, { userId }, context) =>
    resetAuthenticator(tx, {
      actorId: context.actorId,
      userId,
      reason: context.reason,
      sealing: servicesOf(context).sealing,
      now: context.now,
    }),
});

/* Mail provider */

const mailProviderSwitch = acting<{ provider: MailProviderName }>({
  name: 'mail_provider.switch',
  permission: 'providers.manage',
  prepare: async (_db, { provider }, { services }) => {
    const mail = servicesOf({ services }).mail;
    if (!mail) throw new OperationError('INVALID_INPUT');
    const status = await mail.status(provider);
    // In production a provider whose status can't be read is not switched to blind.
    if (mail.production && !status)
      throw new OperationError('PROVIDER_STATUS_UNKNOWN');
    return { sandbox: status?.sandbox ?? null };
  },
  current: async (tx) => {
    const [row] = await tx
      .select({ provider: providerSettings.activeProvider })
      .from(providerSettings)
      .where(eq(providerSettings.kind, 'mail'));
    return row?.provider ?? null;
  },
  describe: async (_tx, { provider }) =>
    `Make ${provider} the active email provider`,
  act: async (tx, { provider }, context) => {
    const mail = servicesOf(context).mail;
    if (!mail) throw new OperationError('INVALID_INPUT');
    const { sandbox } = context.facts as { sandbox: boolean | null };
    if (!(await hasConfirmedMailTest(tx, provider, context.now)))
      throw new OperationError('NO_CONFIRMED_TEST');
    const outcome = await switchMailProvider(tx, {
      staffUserId: context.actorId,
      provider,
      reason: context.reason,
      production: mail.production,
      sandbox,
      configured: mail.configured,
      fallback: mail.fallback,
      now: context.now,
    });
    if (outcome === 'no_confirmed_test')
      throw new OperationError('NO_CONFIRMED_TEST');
    if (outcome !== 'switched')
      throw new OperationError('PROVIDER_NOT_ALLOWED');
    return { provider };
  },
});

let registered = false;

/** Safe to call more than once; registering is what the API and the worker do at start. */
export function registerRealSeriousActions(): void {
  if (registered) return;
  registered = true;
  registerSeriousAction(emailRecovery);
  registerSeriousAction(payoutSettle);
  registerSeriousAction(balanceWriteOff);
  registerSeriousAction(feeChange);
  registerSeriousAction(feeFree);
  registerSeriousAction(grantOwnerAction);
  registerSeriousAction(grantSensitive);
  registerSeriousAction(roleAddSensitive);
  registerSeriousAction(staffResetAuthenticator);
  registerSeriousAction(mailProviderSwitch);
}

/* Routes whose seriousness depends on what is being done */

export type AppliedOrAsked<Result> =
  { state: 'applied'; result: Result } | SeriousActionOutcome;

type Asking = {
  actorId: string;
  grantId: string;
  reason: string;
  services: SeriousActionServices;
};

/**
 * Decides under the lock, and applies there too, so a role that gains a sensitive permission just
 * now can't slip through as harmless. Anything serious goes the long way, after this lets go.
 */
async function applyUnlessSerious<Result>(
  db: Database,
  decide: (tx: Tx) => Promise<{ name: string; payload: unknown } | null>,
  apply: (tx: Tx) => Promise<Result>,
  asking: Asking,
): Promise<AppliedOrAsked<Result>> {
  const first = await guarded(() =>
    db.transaction(async (tx) => {
      await lockStaffAdmin(tx);
      return whileHoldingStaffAdmin(async () => {
        const serious = await decide(tx);
        if (serious) return { serious };
        return { applied: await apply(tx) };
      });
    }),
  );
  if ('applied' in first)
    return { state: 'applied', result: first.applied as Result };
  return requestSeriousAction(db, { ...first.serious, ...asking });
}

const hasSensitive = (permissions: readonly string[]) =>
  permissions.some(isSensitive);

async function grantNameForRole(tx: Tx, roleId: string) {
  if (roleId === 'owner') return 'staff.grant_owner';
  return hasSensitive(await readRolePermissions(tx, roleId))
    ? 'staff.grant_sensitive'
    : null;
}

export function addStaffOrAsk(
  db: Database,
  input: Asking & { email: string; roleId: string },
) {
  const email = normaliseEmail(input.email);
  if (!email) return Promise.reject(new OperationError('INVALID_INPUT'));
  const { roleId, ...asking } = input;
  return applyUnlessSerious(
    db,
    async (tx) => {
      const name = await grantNameForRole(tx, roleId);
      return name
        ? {
            name,
            payload: { kind: 'add', email, roleId } satisfies GrantPayload,
          }
        : null;
    },
    (tx) =>
      addStaff(tx, {
        actorId: input.actorId,
        email,
        roleId,
        reason: input.reason,
        sealing: input.services.sealing,
      }),
    asking,
  );
}

export function changeRoleOrAsk(
  db: Database,
  input: Asking & { userId: string; roleId: string },
) {
  const { userId, roleId } = input;
  return applyUnlessSerious(
    db,
    async (tx) => {
      const name = await grantNameForRole(tx, roleId);
      return name
        ? {
            name,
            payload: { kind: 'role', userId, roleId } satisfies GrantPayload,
          }
        : null;
    },
    (tx) =>
      changeRole(tx, {
        actorId: input.actorId,
        userId,
        roleId,
        reason: input.reason,
      }),
    input,
  );
}

/** Serious when it leaves them holding a sensitive permission they didn't have, however it's done. */
export function setPersonalAccessOrAsk(
  db: Database,
  input: Asking & {
    userId: string;
    additions: readonly string[];
    removals: readonly string[];
  },
) {
  const { userId, additions, removals } = input;
  return applyUnlessSerious(
    db,
    async (tx) => {
      const before = await readStaffAccess(tx, userId);
      if (!before) return null;
      const roleHas = new Set(await readRolePermissions(tx, before.roleId));
      const gains = [...additions, ...roleHas].filter(
        (permission) =>
          !removals.includes(permission) && !before.permissions.has(permission),
      );
      return hasSensitive(gains)
        ? {
            name: 'staff.grant_sensitive',
            payload: {
              kind: 'access',
              userId,
              additions: [...additions],
              removals: [...removals],
            } satisfies GrantPayload,
          }
        : null;
    },
    (tx) =>
      setPersonalAccess(tx, {
        actorId: input.actorId,
        userId,
        additions,
        removals,
        reason: input.reason,
      }),
    input,
  );
}

export function updateRoleOrAsk(
  db: Database,
  input: Asking & {
    roleId: string;
    name?: string;
    description?: string;
    permissions?: readonly string[];
  },
) {
  const { roleId, name, description, permissions } = input;
  const named = {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  };
  return applyUnlessSerious(
    db,
    async (tx) => {
      if (!permissions) return null;
      const stored = new Set(await readRolePermissions(tx, roleId));
      return hasSensitive(permissions.filter((p) => !stored.has(p)))
        ? {
            name: 'role.add_sensitive',
            payload: {
              roleId,
              permissions: [...permissions],
              ...named,
            } satisfies RoleEditPayload,
          }
        : null;
    },
    (tx) =>
      updateRole(tx, {
        actorId: input.actorId,
        roleId,
        reason: input.reason,
        ...named,
        ...(permissions ? { permissions } : {}),
      }),
    input,
  );
}
