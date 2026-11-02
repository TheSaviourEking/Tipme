# Admin Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Several staff on `/ops` with custom roles, per-person access, step-up for sensitive actions, and second-person approval on serious actions that switches on by itself once a second qualified person exists.

**Architecture:** One catalogue in `@tipme/contracts` lists every permission and serious action. Effective access (role plus personal additions minus removals) is computed per request by `staffPermissions`, which `OpsGuard` already uses. Serious actions go through one registry: `requestSeriousAction` runs them at once when nobody else qualifies, otherwise stores a pending request that a different qualified person approves, re-checking people and facts before running.

**Tech Stack:** NestJS guards and controllers, Drizzle/Postgres migrations, Next.js `/ops` client pages, `node:test` integration tests, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-admin-roles-design.md`

## Global Constraints

- The server always decides. Hiding a button is never the only protection.
- `owner` always holds every permission, including future ones, and can't be edited or deleted. `release_check` isn't editable or assignable from the dashboard.
- Effective access = role's permissions + personal additions − personal removals. Adjustments survive a role change.
- Nobody can grant what they don't hold, nor change their own access. Only an owner can create an owner. The last active owner can't be removed or demoted.
- Removal revokes the staff row and drops admin sessions at once.
- Sensitive actions need a written reason and a fresh authenticator code: one code covers 5 minutes in that session (`FRESH_CODE_MS = 300000`), and signing in to `/ops` counts. An approval always needs a code entered for that approval.
- Requests expire after 24 hours (`APPROVAL_TTL_MS = 86400000`).
- Second person: active staff, enrolled authenticator, holds the action's permission, isn't the requester, and has a different normalised email.
- When nobody else qualifies, the action runs at once, with the reason, fresh code, and a log entry and alert saying it ran without a second person.
- Audit rows are append-only (existing triggers). Both requester and approver are recorded.
- New permissions extend `role_permissions_known` in their migration, as `0029` and `0035` did. Migrations are additive.
- Users never see a provider's name; staff screens may name providers. UI follows `docs/design/DESIGN-CONSTITUTION.md`.
- **Base and numbering:** build on the branch holding the payouts work (`feat/live-payments-payouts`, or `dev` once merged). Its migrations are 0052 and 0053, and its later tasks may add more: take the next free number when each migration is written.

## Review Focus

- **A permission removed mid-session:** the next request gets 403, and an already-open page's action fails cleanly. Test in Task 2.
- **Two people approving at once, or approve racing cancel or expiry:** the action runs at most once. Test in Task 5.
- **A role edited or deleted while a request waits:** the request stops and says so. Test in Task 6.
- **The only other qualified person hasn't enrolled yet:** they don't count, so the action runs alone with the alert. Test in Task 4.
- **`grant-owner` run on an account that was removed:** it restores access and is logged. Test in Task 3.

---

### Task 1: The permission catalogue, and splitting coarse permissions

**Files:**

- Create: `packages/contracts/src/ops-catalogue.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/database/src/schema.ts:1145` (`OPS_PERMISSIONS` derives from the catalogue), `packages/database/src/operations/staff.ts:34`, `apps/api/src/ops/email-console.controller.ts`, `apps/api/src/ops/actions.controller.ts`, `apps/web/src/app/ops/staff/page.tsx` (descriptions come from the catalogue)
- Create: a migration extending `role_permissions_known`
- Test: `packages/contracts/test/ops-catalogue.test.mjs`, `tests/integration/ops-catalogue.test.mjs`

**Interfaces:**

- Produces: `OPS_CATALOGUE: Record<OpsPermission, { description: string; group: 'money' | 'people' | 'content' | 'numbers' | 'settings'; sensitive: boolean }>`; `SERIOUS_ACTIONS` names: `email_recovery.start`, `payout.settle`, `balance.write_off`, `fee.change`, `fee.free`, `staff.grant_owner`, `staff.grant_sensitive`, `role.add_sensitive`, `staff.reset_authenticator`, `mail_provider.switch`.
- New permissions: `email.read`, `email.export`, `payments.repair`, `staff.manage`. `payments.recheck` keeps `POST recheck`; `payments.repair` takes `bachs/checkout-recovery`, `bachs/fee-bearer-confirmation`, `bachs/account-recovery`. `email.read` takes `messages/:id/timeline` and `messages/:id/content`; `email.export` takes `export.csv`.

- [ ] **Step 1: Write the failing tests**

```js
test('every route names a permission in the catalogue', ...); // scan @OpsPermission('…') in apps/api/src/ops
test('every catalogue entry has a description and group; money and private ones are sensitive', ...);
test('issues.view alone cannot read email content or export it', ...); // 403s
test('payments.recheck alone cannot run a repair action', ...);
test('owner holds every permission after migrating', ...);
test('release_check keeps exactly its four permissions', ...);
```

- [ ] **Step 2: Run.** `node --test packages/contracts/test/ops-catalogue.test.mjs` and the integration file serially. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the catalogue, the migration and the route changes. `ensureOwnerRole` keeps granting all of `OPS_PERMISSIONS`.
- [ ] **Step 4: Run** those, `tests/integration/ops-access.test.mjs`, `tests/integration/ops-actions.test.mjs`, then `pnpm api:openapi`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): one permission catalogue, and email and repair split out`

---

### Task 2: Custom roles and personal adjustments

**Files:**

- Create: `packages/database/src/operations/staff-admin.ts`, a migration (`staff_permission_overrides(user_id, permission, effect 'add'|'remove', granted_by, created_at)`, primary key on user and permission; `roles` gains `description`, `system boolean`), `apps/api/src/ops/staff.controller.ts`
- Modify: `packages/database/src/operations/staff.ts:85` (`staffPermissions`)
- Test: `tests/integration/ops-roles.test.mjs`

**Interfaces:**

- Produces: `createRole(db, { actorId, name, description, permissions, reason })`, `updateRole(db, { actorId, roleId, name?, description?, permissions?, reason })`, `deleteRole(db, { actorId, roleId, reason })`, `setPersonalAccess(db, { actorId, userId, additions, removals, reason })`, `effectiveAccess(db, userId): { roleId, permissions, additions, removals }`. Role ids are generated UUID text. All write an audit event. Routes under `/v1/ops/staff` use `staff.manage`.
- Starter roles created by the migration (`system = false`, so editable): Support (`issues.view`, `issues.resolve`, `search.view`, `pages.suspend`), Finance (`issues.view`, `search.view`, `analytics.view`, `payments.recheck`, `fees.manage`), Marketing (`analytics.view`, `market.edit`).

- [ ] **Step 1: Write the failing tests**

```js
test('a role grants what is ticked, and a new role starts with nothing', ...);
test('owner and release_check cannot be edited or deleted', ...);
test('a role with people on it cannot be deleted', ...);
test('additions and removals apply, and survive a role change', ...);
test('a permission removed mid-session gives 403 on the next request', ...);
test('granting a permission you do not hold is refused', ...);
test('changing your own access is refused', ...);
test('every change writes an audit event with actor and reason', ...);
```

- [ ] **Step 2: Run** serially. Expected: FAIL.
- [ ] **Step 3: Implement.** Confirm `resolveOpsGrant` caches nothing; `staffPermissions` keeps being read on each request. `owner` still resolves to all of `OPS_PERMISSIONS`, ignoring overrides.
- [ ] **Step 4: Run** it and `ops-access.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): custom roles and per-person access`

---

### Task 3: Adding and removing people

**Files:**

- Modify: `packages/database/src/operations/staff-admin.ts`, `packages/database/src/operations/staff.ts:134` (`grantOwner` shares the enrolment code path), `apps/api/src/ops/staff.controller.ts`, `packages/mail/src/templates/types/` (a staff invitation)
- Test: `tests/integration/ops-people.test.mjs`

**Interfaces:**

- Produces: `normaliseStaffEmail(email): string` (lower case, drop `+tag`, drop dots for `gmail.com` and `googlemail.com`); `addStaff(db, { actorId, email, roleId, reason, sealing })`, `removeStaff(db, { actorId, userId, reason })`, `changeRole(db, { actorId, userId, roleId, reason })`, `resetAuthenticator(db, { actorId, userId, reason, sealing })`, `activeStaffList(db)`. The invitation email carries the one-time enrolment link (30 minutes); only its SHA-256 is stored, as today.

- [ ] **Step 1: Write the failing tests**

```js
test('adding a person emails an enrolment link, and they reach /ops only after enrolling', ...);
test('an email already on a recipient account uses that account', ...);
test('name+tag@gmail.com and n.a.m.e@gmail.com are refused when name@gmail.com is staff', ...);
test('removal takes effect on the next request and drops admin sessions', ...);
test('the last active owner cannot be removed or demoted', ...);
test('only an owner can create an owner', ...);
test('grant-owner restores a removed account and is logged', ...);
```

- [ ] **Step 2: Run** serially. Expected: FAIL.
- [ ] **Step 3: Implement.** The last-owner check locks the owner rows in the transaction, so two removals at once can't leave none.
- [ ] **Step 4: Run** it and `ops-access.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): add and remove staff from the dashboard`

---

### Task 4: Fresh codes, and the approval engine's lone path

**Files:**

- Create: `packages/database/src/operations/serious-actions.ts`, `apps/api/src/ops/fresh-code.guard.ts`, a migration (`ops_sessions.last_totp_at`; `approval_requests(id, action, payload jsonb, summary, permission, requested_by, reason, status 'pending'|'approved'|'rejected'|'cancelled'|'expired'|'stale', decided_by, decided_reason, created_at, expires_at, decided_at)`; `audit_events` keeps its shape, with both people in its details)
- Modify: `apps/api/src/ops/ops-access.controller.ts` (sign-in sets `last_totp_at`), `apps/api/src/ops/permission.decorator.ts`
- Test: `tests/integration/ops-serious-actions.test.mjs`

**Interfaces:**

- Produces: `@FreshCode()` decorator; `registerSeriousAction({ name, permission, validate(tx, payload), describe(tx, payload): string, run(tx, payload, ctx) })`; `qualifiedApprovers(db, { permission, requesterId }): string[]`; `requestSeriousAction(db, { name, payload, actorId, reason }): { state: 'ran'; aloneReason: 'no_second_person' } | { state: 'pending'; requestId }`.

- [ ] **Step 1: Write the failing tests**

```js
test('a sensitive route refuses without a code in the last 5 minutes, and accepts within them', ...);
test('with nobody else qualified, the action runs at once and logs that no second person was available', ...);
test('the alone path posts an alert', ...);
test('someone invited but not enrolled does not count as qualified', ...);
test('someone without the permission does not count as qualified', ...);
test('someone on the same normalised email does not count as qualified', ...);
test('with a second qualified person, nothing runs and a pending request exists', ...);
test('a reason is required', ...);
```

- [ ] **Step 2: Run** serially. Expected: FAIL.
- [ ] **Step 3: Implement.** Mark sensitive routes `@FreshCode()` from the catalogue's `sensitive` flag, and fail a test if a sensitive route lacks it. Alerts use the existing outbox alert route.
- [ ] **Step 4: Run** it and `ops-actions.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): fresh codes and serious actions with a lone-admin path`

---

### Task 5: Approving, rejecting and expiry

**Files:**

- Modify: `packages/database/src/operations/serious-actions.ts`; create `apps/api/src/ops/approvals.controller.ts`
- Modify: `apps/worker/src/ensure-schedule.ts` (expire old requests)
- Test: `tests/integration/ops-approvals.test.mjs`

**Interfaces:**

- Consumes: Task 4's registry.
- Produces: `listApprovals(db, { actorId, status? })`, `approveRequest(db, { requestId, actorId, reason? })`, `rejectRequest(db, { requestId, actorId, reason })`, `cancelRequest(db, { requestId, actorId })`, `expireRequests(db, { now })`. Approve always needs a code entered for that approval.

- [ ] **Step 1: Write the failing tests**

```js
test('you cannot approve your own request', ...);
test('someone without the permission cannot approve', ...);
test('approval runs the action once, even with two approvers at once', ...);
test('a requester who was removed or lost the permission closes the request without running', ...);
test('facts that changed stop the action and mark it stale', ...);
test('requests expire after 24 hours, and approve racing expiry runs at most once', ...);
test('approve needs a code entered for that approval, not the 5-minute window', ...);
test('the audit event names both people', ...);
```

- [ ] **Step 2: Run** serially. Expected: FAIL.
- [ ] **Step 3: Implement** with `SELECT … FOR UPDATE` on the request row. A request stays open for cancelling if the other qualified people are removed, and the requester can then act alone.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): approve, reject and expire serious actions`

---

### Task 6: Serious actions behind approval

**Files:**

- Modify: `apps/api/src/ops/account-recovery.controller.ts`, `apps/api/src/ops/pages.controller.ts`, `apps/api/src/ops/providers.controller.ts`, `apps/api/src/ops/staff.controller.ts`, and payout-resolution routes if live-payments Task 7 is on the base
- Create: `packages/database/src/operations/serious-actions-registered.ts`
- Test: `tests/integration/ops-serious-gating.test.mjs`

**Interfaces:**

- Consumes: `registerSeriousAction`, `requestSeriousAction`.
- Serious: every name in `SERIOUS_ACTIONS`. `staff.grant_sensitive` covers giving a role containing a sensitive permission and adding a sensitive personal permission. Role edits carry the role's `updated_at`; a changed or deleted role makes the request `stale`. `payout.settle` and `balance.write_off` register only if their operations exist on the base, and otherwise Task 12 of the live-payments plan lists them as a precondition.
- Not serious: removing a person, suspending a page, granting Pro, revealing private details, recheck.

- [ ] **Step 1: Write the failing tests** (a table over `SERIOUS_ACTIONS`)

```js
for (const action of wired) {
  test(`${action}: waits for a second person when one qualifies`, ...);
  test(`${action}: runs alone with the alert when nobody qualifies`, ...);
}
test('giving someone a role with no sensitive permission applies at once', ...);
test('giving someone a role containing a sensitive permission waits', ...);
test('a role edited or deleted while a request waits stops the request', ...);
test('removing a person never waits', ...);
```

- [ ] **Step 2: Run** serially. Expected: FAIL.
- [ ] **Step 3: Implement.** Routes answer `202 { requestId }` when pending and their normal response when run. Keep each action's body in one function.
- [ ] **Step 4: Run** it, `ops-actions.test.mjs`, `ops-email-console-api.test.mjs`, then `pnpm api:openapi`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): serious actions wait for a second person`

---

### Task 7: The dashboard screens

**Files:**

- Create: `apps/web/src/app/ops/staff/people/`, `apps/web/src/app/ops/staff/roles/`, `apps/web/src/app/ops/approvals/`, `apps/web/src/lib/ops-staff-api.ts`
- Modify: `apps/web/src/app/ops/staff/page.tsx`, `apps/web/src/app/ops/ops-shell.tsx` (menu from permissions), action forms that can return `202`
- Test: `tests/e2e/ops-staff.spec.ts`, `apps/web/test/ops-menu.test.mjs`

**Interfaces:**

- Consumes: Tasks 2–6's routes. `useOpsAccess()` supplies permissions.

- [ ] **Step 1: Write the failing tests**

```ts
test('an owner adds a person; they sign in, enrol, and see only their menu', ...);
test('a sensitive permission warns when ticked', ...);
test('a person with an adjustment shows what differs from their role', ...);
test('editing a role shows who is affected before saving', ...);
test('a serious action says it is waiting, and a second person sees the exact change and approves', ...);
test('an action taken alone says so', ...);
```

- [ ] **Step 2: Run** `pnpm exec playwright test tests/e2e/ops-staff.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement,** following the existing ops pages and the design constitution. A fresh-code prompt appears when an API call answers that one is needed.
- [ ] **Step 4: Run** it, `node --test apps/web/test/ops-menu.test.mjs` and `apps/web/test/no-provider-names.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): people, roles and approvals in the admin dashboard`

---

### Task 8: Documentation

**Files:**

- Create: `docs/runbooks/admin-roles.md`
- Modify: `docs/adr/ADR-0010-admin-access-audit-analytics.md` (dated amendment), `docs/05-SECURITY.md`, `docs/runbooks/issues-inbox.md`, `docs/runbooks/production.md`, `docs/superpowers/plans/2026-10-31-live-payments.md` (Task 12 precondition)
- Test: `packages/contracts/test/ops-catalogue.test.mjs`

- [ ] **Step 1: Write the failing test:** every permission and serious action in the catalogue appears in `docs/runbooks/admin-roles.md`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Write the runbook:** every permission in plain words; adding and removing people; how approvals work, including the lone-admin rule; lost phones; a locked-out owner (`grant-owner`); and what roles cannot protect: server access and GitHub deploy rights, `pnpm ops:set-email`, and the Bachs, Aiven, ZeptoMail, Cloudflare and Vercel logins. Add the live-payments precondition: serious money actions are behind approval before payments are switched on, if there is more than one admin.
- [ ] **Step 4: Run** it, the full serial integration suite (12 macOS backup failures expected), `pnpm test`, `pnpm lint`, `pnpm format:check`. Expected: PASS apart from those.
- [ ] **Step 5: Commit** `docs(ops): admin roles runbook`
