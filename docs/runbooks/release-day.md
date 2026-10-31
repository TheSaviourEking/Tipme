# Runbook: release-day checklist

"On the release day, everything must be proven to work … from the tips to the admin dashboard … cohesively." This is the list that proves it.

## The day before

- [ ] **Code gates on the commit:** CI is green (format, lint, typecheck, unit, build, integration, e2e).
- [ ] **Migrations:** if the release adds any, run the rollback drill locally ([deploy-and-rollback](deploy-and-rollback.md)).
- [ ] **Backups:** the restore drill on staging PASSES on last night's backup ([backup-and-restore](backup-and-restore.md)).
- [ ] **Off-server copy:** a backup from the last 24 hours is present in the off-site bucket (if configured).

## Release to staging

- [ ] **API and worker:** the **Deploy staging** workflow succeeds (checks, build, ship, deploy, full release check).
- [ ] **Web app:** Vercel shows the same commit for the web app.
- [ ] **Read-only check:** `pnpm release:check --web … --api … --expect-version <sha>` passes.
- [ ] **Full check:** `pnpm release:check … --full` passes. That proves the whole story:
  1. QR visit → tip → paid;
  2. the dashboard and notification;
  3. a provider problem in the admin inbox, resolved;
  4. withdrawal;
  5. admin numbers unchanged by the rehearsal.
- [ ] **A human looks at the admin Overview and Issues:** nothing new and unexplained.

## Practise going back (at least once per release cycle)

- [ ] `/srv/tipme/live/scripts/rollback.sh` → the read-only check passes on the previous version.
- [ ] Vercel Instant Rollback → the web app serves the previous deployment.
- [ ] Redeploy the new version → the full check passes again.

## What a failed check leaves behind

The full check deletes its own account and finishes its run, even when a step fails. A check that crashed before that leaves a live, tagged page (`rc_…`). On test copies, the worker sweeps every hour (`rehearsals.sweep`). Two hours after a rehearsal page was created, it erases the account through the normal deletion, without the balance block or the goodbye email, and finishes any run still open, which resolves its issues. Real pages are never touched, and ledger, history and audit stay as written. The log line is `rehearsals.swept` with `erased` and `runsFinished`.

## Stop and do not release if

- any check fails, or reports **live payments** (real money is not approved: D-03 to D-08);
- the restore drill fails;
- a migration is not compatible with the previous release.

## Afterwards

Record in the release notes:

- the version;
- the check results (`test-results/release-check.json`);
- the backup file used for the drill;
- anything rolled back and why.
