# Admin roles: many staff, custom roles, per-person access, second-person approval

Status: DRAFT for owner approval, 1 November 2026.
Related: ADR-0010 (admin access, audit), `docs/05-SECURITY.md`, `docs/runbooks/issues-inbox.md`, `docs/superpowers/plans/2026-10-31-live-payments.md` (its Task 7 adds new money actions).

## 1. Intent

TipMe will have several admins from different departments: "marketing, finance etc. different departments would exist, I can't point entirely yet." The owner must be able to decide what each role and each person can access, from the dashboard. They worry about "the wrong person moves money, read logs, change account settings".

The owner's rule for approvals: one authorised person plus a full log is enough, "except on the really serious ones, that's where we need the 2nd person". And: "When it's only 1 admin, it should work. When there are more admins … it should go on to require 2."

## 2. What exists today

- `roles`, `role_permissions`, `staff` (one role per person), `staff_enrolments`, `ops_sessions`, `ops_lockouts`, and the append-only `audit_events`.
- Every `/v1/ops/*` route names one permission through `@OpsPermission`. `OpsGuard` checks it on the server: no grant gives 404, a missing permission gives 403.
- Sign-in to `/ops` needs a recipient session and an authenticator code.
- `OPS_PERMISSIONS` is a fixed list of 14, also held in a database check constraint. Roles in use: `owner` (everything) and `release_check`.
- `/ops/staff` is read-only. Staff are added only by the server command `grant-owner`.

## 3. Goals

1. Create, edit and delete roles from `/ops/staff`, by ticking permissions. A new department needs no code change.
2. Add a person by email, give them one role, and add or remove individual permissions for that person.
3. Remove a person, or change their access, with immediate effect.
4. Second-person approval on the serious actions, switching on by itself once a second qualified person exists.
5. Sensitive actions are harder to reach, and everything is logged.
6. Documented: what each permission does, how to add and remove people, how approvals work, and what roles cannot protect.

## 4. Non-goals

- Single sign-on or an external identity provider.
- A person holding more than one role. A role plus personal adjustments covers it.
- Protecting what sits outside the dashboard (see §7).
- Approval chains of more than two people.

## 5. Anti-goals

These would count as failures even if the feature "works":

- Someone gives themselves, or anyone else, more access than they hold.
- The business gets locked out: no active owner remains.
- Hiding a button is the only protection. The server always decides.
- A person approves their own request, including by asking from one account and approving from another that is really the same person's second account on the same email.
- An approved action runs on stale facts.
- A removed person keeps access for any length of time.
- A log entry can be edited or removed, by anyone, including the owner.

## 6. Design

### 6.1 Permissions

- **Split the coarse ones.** Today `issues.view` also lets someone read email content and download the email export, and `payments.recheck` covers four actions of different risk. New permissions (names left to the builder):
  - reading email content;
  - exporting email data;
  - payment recheck (read-only), separate from the three repair actions;
  - staff and roles management;
  - approving requests is not a permission of its own (see §6.5).
- **Migration keeps behaviour:** the `owner` role gains every new permission. Nobody else exists on production beyond owner and `release_check`, whose set is unchanged.
- **Every permission has an entry in one catalogue:** name, plain description, group, and whether it is **sensitive** and whether it is **serious** (§6.5). The dashboard, the API and the docs read from this catalogue, and a test fails if a route names a permission missing from it.
- **Sensitive** means: moving or settling money, reading logs or private details, changing accounts or settings. In the dashboard these show a warning when ticked.

### 6.2 Roles

- **Owner** is built in. It always holds every permission, including future ones, and can't be edited or deleted.
- **`release_check`** is a system role: not editable, and not assignable from the dashboard.
- **Custom roles:** name, description and ticked permissions. New roles start with nothing ticked.
- **Starter roles (builder's call on the exact ticks; the owner can edit them):** Support, Finance, Marketing. None holds staff management.
- **Deleting a role** is refused while anyone has it.
- **Editing a role** takes effect on the next request for everyone holding it, and shows who is affected before saving.

### 6.3 People

- **Effective access = role's permissions + personal additions − personal removals.** Adjustments stay if the role changes. The dashboard shows a person's effective access and marks what differs from their role.
- **Adding someone:** enter their email and role. They get an email; they sign in with an emailed code and enrol an authenticator through a one-time link, valid for 30 minutes as today. No server command is needed. An email already on a recipient account uses that account; staff access stays a separate step behind the authenticator.
- **Nobody can grant what they don't hold.** A person managing staff can only give a role or permission whose every permission they hold themselves. Only an owner can create an owner.
- **Nobody can change their own access.**
- **Removing someone** revokes the staff row and drops their admin sessions at once. The audit trail stays.
- **The last active owner** can't be removed or demoted.
- **Re-enrolment:** an owner can reset a person's authenticator from the dashboard, for a lost phone. It's serious (§6.5).
- **`grant-owner`** stays as the server-side way in if every owner is locked out, and it is logged.

### 6.4 Sensitive actions

- **Fresh authenticator code:** sensitive actions ask for a current code unless one was entered in the last 5 minutes (builder may tune). So an unattended laptop can't move money.
- **Required written reason** on every sensitive action, stored in the audit event.
- **Private details stay masked by default.** Revealing is a permission and each reveal is logged, as today.
- **Access to logs is itself a permission.**
- **Alerts:** role changes, new staff, removals, approvals and any action taken alone (§6.5) post to Slack through the existing alert route, and are visible on the admin Overview.

### 6.5 Second-person approval

**Serious actions (the owner reviews this list; it lives in the catalogue, so it can change):**

- email recovery: moving an account to a new email address;
- settling or writing off money: marking an unresolved payout paid or failed, writing off a balance;
- changing a page's fee, or making it fee-free;
- staff access: creating an owner, giving anyone a sensitive permission, adding a sensitive permission to a role, resetting someone's authenticator;
- switching the active email provider.

**One authorised person plus the log (not serious):** releasing a withdrawal pause; suspending or restoring a page; revealing private details; rechecking a payment; repair actions that only follow a provider read; granting a Pro plan; editing market data; exporting email data; removing a person (removal must be fast).

**How it works:**

1. A person with the permission requests the action and writes a reason. Nothing happens yet.
2. Everyone else qualified sees it in an approvals list, with exactly what will change, and is alerted.
3. A different qualified person approves or rejects it, with a fresh authenticator code.
4. On approval the server re-checks everything against current data, then runs it. If the facts changed, for example the payout has since been paid, it stops and says so.
5. Requests expire after 24 hours. The requester can cancel their own.
6. Every step is logged: request, approval or rejection, the outcome, who, when and why.

**Who qualifies as the second person:** an active staff member with an enrolled authenticator who holds that same permission, and who isn't the requester. A marketing admin can't approve a finance write-off, and a person's approval never counts for their own request.

**When nobody else qualifies (the owner's rule):** the action runs straight away with one person. The reason is still required, the fresh code is still required, and the log entry and alert say plainly that it ran without a second person because none was available. Once a second qualified person exists, approval switches on by itself, with no setting to change.

**Closing the obvious loophole:** "nobody else qualifies" is worked out by the server at request time, and a change that removes the last other qualified person for a serious permission is itself alerted. Removing colleagues to act alone stays possible for an owner, but it can't be done quietly.

### 6.6 Screens

Under `/ops/staff`, following `docs/design/DESIGN-CONSTITUTION.md`:

- **People:** list, add, change role, adjust access, remove, reset authenticator.
- **Roles:** list, create, edit (permissions grouped, sensitive and serious ones marked), delete.
- **Approvals:** pending, with the exact change; a history.
- The admin menu shows only what the person can use.

### 6.7 Documentation

- `docs/runbooks/admin-roles.md`: every permission in plain words (generated from, or tested against, the catalogue), adding and removing people, approvals, lost phones, a locked-out owner.
- **What roles cannot protect:** anyone with server access or GitHub deploy rights can read every secret and reach the database; `pnpm ops:set-email` and `grant-owner` bypass the dashboard; Bachs, Aiven, ZeptoMail, Cloudflare and Vercel have their own logins. Those stay with very few people.
- ADR-0010 gets a dated amendment. `docs/05-SECURITY.md`'s two-person line points here.

### 6.8 Order against the live-payments plan

Live-payments Task 7 adds new staff actions: resolving unresolved and conflicting payouts, releasing holds, recording money-issue outcomes. They use one authorised person plus the log first, and become serious actions when this ships. **Serious money actions must be behind this design before payments are switched on** (add to Task 12's preconditions) if there is more than one admin by then.

### 6.9 How approvals and access are built (builder's calls, for the owner to check)

- **Serious is per action, not per permission.** A catalogue of named serious actions, each naming the permission it needs. The same route can be serious or not depending on content: giving someone a role with no sensitive permissions isn't, and giving them one with a sensitive permission is. The qualified second person holds the permission that action names.
- **One approvals mechanism.** A pending request stores the action's name and its payload. Each serious action registers three things: how to validate it, how to describe the exact change, and how to run it after a fresh re-check. Existing routes call this instead of acting directly.
- **Two people authorise it.** The requester and the approver each give a fresh code, and both are recorded on the audit event.
- **Staff changes wait too.** A serious staff change, including giving someone a role that contains a sensitive permission, takes effect only after approval, and the People and Roles screens show it as pending. If the role was edited or deleted while the request waited, the request stops and says so; the requester asks again.
- **Requests re-check people as well as facts.** At approval, the requester must still be active and hold the permission, and so must the approver. If not, the request closes without running.
- **A lone admin never leaves a pending request.** With nobody else qualified, the action runs at once (§6.5). If the other qualified people are removed while a request waits, the requester cancels it and acts alone, with the alert.
- **Lone-admin scope:** it covers every serious action, including staff and owner changes, as the owner said it should "work" with one admin. Someone invited but not yet enrolled doesn't count as qualified. An owner could add a second account to approve their own requests; the alerts make that visible, and it's accepted.
- **One person, one staff account.** Requester and approver are compared by user id and by normalised email (lower case, without a `+tag`, and without dots for Gmail addresses). Adding a person whose normalised email matches existing staff is refused.
- **Fresh code:** stored as `last_totp_at` on `ops_sessions`. Signing in to `/ops` counts. One code covers several sensitive actions for 5 minutes in that session. An approval always needs a code entered for that approval.
- **Access is read on every request.** Revocation relies on `OpsGuard` reading permissions per request; the builder confirms nothing caches them, and personal adjustments extend that query.
- **Role ids** are generated and stable, and names can be changed. `owner` and `release_check` stay fixed. New permissions extend the database's check constraint in their migration, the way new issue kinds do.
- **Live-payments plan:** this plan doesn't build Task 7's actions. It adds them to the serious catalogue if they've landed, and the Task 12 precondition goes in that plan.

## 7. Testing

- **Authorisation matrix:** every `/v1/ops/*` route against a role with and without its permission. A test fails if a route has no catalogue entry.
- **Effective access:** role, additions, removals, role changes, revocation taking effect on the next request.
- **Escalation refusals:** granting more than you hold, changing your own access, a non-owner creating an owner, removing the last owner.
- **Approvals:** self-approval refused; unqualified approver refused; expiry; a re-check that stops a stale action; each serious action has a test showing it can't run without approval when a second qualified person exists, and runs alone with the alert when none does.
- **Concurrency:** two approvals at once run the action once.
- **Audit:** every path writes its event; audit rows can't be changed.
- **e2e:** add a person with a role, sign in, see only their menu, request and approve from two accounts.

## 8. Decisions this records

- The owner's: custom roles and per-person adjustments; one person plus the log by default; a second person for serious actions; a lone admin can act alone, and approval switches on by itself once a second qualified person exists.
- Builder's, for the owner to check: the serious list in §6.5 (especially fees, and not requiring approval to remove someone); starter roles; the 5-minute fresh-code window; 24-hour expiry; a person's additions surviving a role change.

## 9. Left to the builder

Exact table shapes, permission names, screen layout, starter roles' ticks, the alert wording, and the order of work.
