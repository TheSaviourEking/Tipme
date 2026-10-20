# PR-010 design — release rehearsal and staging

Status: the user said "Build/write the code"; that is taken as approval of what was agreed in chat. Date: 2026-10-19. Calls marked _(agent's call)_ are open to review.

## Intent

The delivery plan's PR-010 is "Release rehearsal: e2e, performance, a11y, backup/restore, deploy staging, rollback and runbooks". In the user's words, on release day:

- "everything must be proven to work … from the tips to the admin dashboard etc. Everything must work cohesively";
- it should run "on the app anywhere it's set up";
- it should clean up after itself when it creates data, or stick to read-only checks on copies that real people use;
- it must run on staging **and** keep money and audit records unchangeable ("Both");
- staging is a VPS (not yet bought: "I'd get the VPS and you wire it in later") for everything except the web app, and Vercel for the web app, on the user's own domain.

The free Render/Neon demo built by another session was "just a test", not staging.

## Goals

1. **One release check, pointed at any copy:** `pnpm release:check --web <url> --api <url> [--full]`.
   - The **full** check plays the whole story in a real browser:
     1. a visitor arrives by QR link;
     2. tips, and payment is confirmed;
     3. the recipient sees the dashboard and the notification;
     4. the recipient withdraws;
     5. a provider problem lands in the admin inbox;
     6. staff open it and resolve it;
     7. the admin numbers stay unaffected by the check.

     It also measures LCP on a throttled phone and runs accessibility scans.

   - The **read-only** check creates nothing. It checks:
     - health and the release information;
     - public pages: load, speed, accessibility;
     - private pages carry noindex;
     - the admin area refuses outsiders;
     - real payments are off;
     - the version is the expected one.
2. **A copy declares what it is** with `RELEASE_KIND=test|live` (default `live`, fail-safe). The full check refuses to run unless the copy says `test`.
3. **Rehearsal data is marked and kept out of sight, never deleted** (the user's "both"):
   - A full check opens a rehearsal run. Its recipient's page is tagged with the run.
   - Everything that hangs off that page (tips, ledger, issues, analytics) is excluded from totals, lists and dashboards.
   - At the end, the recipient withdraws everything and deletes their account through the normal flow, which erases personal details. Open rehearsal issues are closed by the system with the reason "release check".
   - Append-only records (ledger, status history, audit, provider events) stay exactly as written. Nothing gains a way to edit or delete them.
4. **Staging:**
   - Vercel serves the web app at `https://staging.<domain>`.
   - One VPS at `https://api.staging.<domain>` runs Docker Compose with Caddy (automatic HTTPS), the API, the worker, Postgres 16 and Redis 7.
   - Only ports 80, 443 and SSH are open. Postgres and Redis are never published.
   - Pretend money and pretend messaging only.
   - Private behind the existing preview password _(agent's call)_.
5. **Release and rollback:**
   - Images are built on the VPS from a git commit and tagged with its SHA _(agent's call: no registry account needed)_.
   - A deploy runs: backup → migrate → switch → health → read-only check.
   - Rollback redeploys the previous SHA.
   - Migrations are **forward-only and backward-compatible with the previous release** (expand/contract), so a rollback never needs a down-migration. This is enforced by a rollback drill.
   - The web app rolls back with Vercel's own instant rollback.
6. **Backups and restore:**
   - A nightly, encrypted `pg_dump`, taken from the same database snapshot as a manifest (row counts and ledger totals).
   - Kept on the server, plus an optional off-server copy.
   - A restore drill restores into a scratch database and proves the manifest matches and the books balance.
7. **Runbooks:**
   - setting up the VPS (with hardening);
   - setting up Vercel;
   - deploy;
   - rollback;
   - backup and restore;
   - the release-day checklist.

   Also ADR-0011 and `docs/PR-010-VERIFICATION.md`.

## Non-goals

- Buying or configuring the VPS, DNS or Vercel project. The user will provide them; wiring in happens later.
- Real payments or real messaging (D-03 to D-08 are still open).
- A production deployment. Staging is built so production can copy it later.
- Changing or finishing the other session's Render/Neon demo work (the `scripts/preview` gateway stays as is).

## Anti-goals

- A release check that leaves visible test tips or recipients in admin numbers or lists.
- Any edit or delete path for ledger, status history, audit or provider events.
- Running the full check against a copy that has real people.
- Secrets in the repository, logs, chat or browser bundles.
- Pretend inboxes (which show sign-in codes) reachable without the preview password.

## Constraints

- The AGENTS.md financial invariants, the ADRs, and integer minor units for money.
- No real payments.
- Every new third-party tool is pinned and registered: the Caddy image, the Postgres client in the image, the rclone image.
- Local-only guards on maintenance scripts stay. A remote migration needs an explicit target confirmation and a fresh backup.

## Builder's design (agent's calls)

- **Bring-up order:**
  1. The web app and API stay separate origins on the same site (`staging.` and `api.staging.`), as in local development and e2e. Credentialed CORS and the SameSite=Lax session cookie work unchanged.
  2. The API may bind `0.0.0.0` (needed inside the container); Caddy is the only published entry.
- **The preview gate across two hosts:**
  - **Ticket:** the signed ticket (HMAC of the expiry with the preview password) is set by a login page on the web app.
  - **Cookie:** `__Secure-tipme_preview`, `Domain=staging.<domain>`, so the API host receives it too. Tickets last 12 hours.
  - **Web side:** a Next `proxy.ts` gate.
  - **API side:** a Nest middleware gate, active only when `DEPLOYMENT_MODE=preview`.
  - **Exempt:** `/health/*`, the release endpoints (they carry their own bearer token), and signed provider webhooks.
  - **Server-to-server calls** (web server → API, API → web revalidate) carry a key derived from the password instead of the cookie.
- **Rehearsal runs:**
  - `POST /v1/release/runs` needs `Authorization: Bearer <RELEASE_CHECK_TOKEN>` and `RELEASE_KIND=test`, and creates a run.
  - Claiming a handle with header `x-tipme-rehearsal: <runId>` tags the page.
  - `POST /v1/release/runs/:id/finish` closes the run's open issues as `system`.
- **The check's admin account:** a dedicated staff role `release_check` (`issues.view`, `issues.resolve`, `analytics.view`, `audit.view`), granted once on the server with `pnpm ops:grant-owner --role release_check`. Its authenticator secret is kept in the check's environment.
- **Exclusions:**
  - profiles get `rehearsal_run_id`;
  - analytics events get `rehearsal`;
  - health/visibility metrics, the issue list (by default) and top pages skip rehearsal pages;
  - the issue list can show them on request (the check uses this).
- **Backups:**
  - a Node tool in the API image, using a `REPEATABLE READ` snapshot exported to `pg_dump --snapshot`;
  - encrypted with AES-256-GCM using `BACKUP_KEY`;
  - kept 14 days, with an optional rclone copy to any S3-compatible bucket;
  - scheduled by a small loop container in Compose.
- **The local proof:** the whole staging stack runs on this machine with Caddy `tls internal`. Every drill and the full check run against it now. On the VPS the same files run with real certificates.

## Left to the builder

- File layout under `deploy/`.
- The exact checks in read-only mode, beyond those listed.
- Script language (bash or Node).
- Copy wording.

## Risks

- **The other session works in the same repository.** PR-010 touches its preview config only by adding to it, and records which files it changed.
- **Local proof is not the VPS.** Memory, real TLS and DNS are unproven until wiring-in. The runbook lists the first-run checks.
