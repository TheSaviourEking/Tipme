# Runbook: production (api.usetipme.xyz)

Production runs on the same server as staging, as its own Compose project `tipme-production`: two API colours (`api-blue`, `api-green`, three copies each, one colour serving at a time), two workers and Redis. Postgres is **Aiven's**. The web app is Vercel's. The one edge Caddy (`tipme-edge`) owns ports 80/443 for both environments and sends production traffic only to copies whose `/health/ready` passes.

Real money stays off (`PAYMENTS_LIVE_ENABLED=false`) until launch day step 5. Nothing here approves live payments: see `docs/00-DECISIONS.md`.

Related: `remote-database.md` (Aiven, roles, CA), `staging-setup.md` (the edge), `photos.md` (R2), `deploy-and-rollback.md` (staging's deploys), the live-payments activation runbook `live-activation.md` (added by the live-payments plan, Task 12).

## 1. Server setup (owner, once)

Production has **its own deploy user and SSH key** (owner, Q10), so a staging deploy cannot read production's settings.

```sh
# As root
adduser --disabled-password --gecos '' tipme-prod
usermod -aG docker tipme-prod
install -d -o tipme-prod -g tipme-prod -m 700 /srv/tipme-production
install -d -o tipme-prod -m 700 /home/tipme-prod/.ssh
# Append the production Actions key's public half (step 2) to /home/tipme-prod/.ssh/authorized_keys (mode 600).
```

- **Accepted for now:** membership of the `docker` group is root-equivalent on this machine. Anyone who can run Docker as `tipme-prod` or `deploy` can read the other's files and containers. Two users keep the SSH keys and env files apart; they are not a full separation. Only a second machine is (spec §6.10).
- **Settings:** copy `deploy/production.env.example` to `/srv/tipme-production/production.env`, `chmod 600`, owned by `tipme-prod`. Generate every secret fresh (the commands are at the top of the example). Never copy one from staging. Check settings by name only: `grep -c '^NAME=.\+' production.env`.
- **The CA file:** Aiven's CA certificate at `/srv/tipme-production/db-ca.pem` (mode 644). The deploy refuses to run without it.
- **DNS:** `api.usetipme.xyz` → the server's address. Fix the root `_dmarc` record to a single record before launch.

## 2. GitHub settings (owner, once)

The `deploy-production` workflow (hand-run, from `main` only) and `watch-production` (every 5 minutes) read:

**Environment `production`** (Settings → Environments → New environment):

- **Required reviewer:** the owner. **Deployment branches:** only `main`.
- **Secrets:**
  - `PRODUCTION_SSH_KEY`: the private half of a key made only for this (`ssh-keygen -t ed25519 -f tipme-prod-actions -N '' -C tipme-prod-actions`); its public half goes in `tipme-prod`'s `authorized_keys`. Delete the local file once stored.
  - `PRODUCTION_SSH_KNOWN_HOSTS`: `ssh-keyscan <server>` output, fingerprint checked against `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server.
  - `SLACK_WEBHOOK_URL` (optional): deploy results to Slack.

**Repository variables** (Settings → Secrets and variables → Actions → Variables → Repository). Repository-level, because the watcher's `if:` cannot see environment variables:

- `PRODUCTION_SSH` = `tipme-prod@<server>`;
- `PRODUCTION_WEB_URL` = `https://usetipme.xyz`;
- `PRODUCTION_API_URL` = `https://api.usetipme.xyz` (the watcher stays off while this is empty);
- `PRODUCTION_PAYMENTS_LIVE` = `false`, changed to `true` only at launch day step 5 (the watcher alerts when `/health/release` disagrees);
- `STAGING_API_URL` (already set for Deploy staging): the deploy gate reads staging's version from it. It must stay a variable; as a secret the gate cannot read it.

**Repository secret:** `ALERT_WEBHOOK_URL` (Slack incoming webhook) for the watcher's alerts.

The worker posts payment reserve alerts to the same kind of webhook: set `ALERT_WEBHOOK_URL` (https) in the server's production env file too. It is a secret, and blank means the alert is only written to the worker log (with a startup warning, and the alert is not counted as sent, so it goes out as soon as the address is set). Once `PAYMENTS_LIVE_ENABLED` is true, the production worker refuses to start without it. Optionally set `BACHS_RESERVE_ALERT_MINOR` (kobo, a positive whole number; blank means 100000, which is ₦1,000). The worker reads the reserve every 15 minutes, alerts at the first low reading and at the first unreadable one, then again every 6 hours while it lasts, shows the latest reading on the staff Overview (`analytics.view`), and deletes readings older than 90 days on each check. `GET /health/payments` tells the watcher `reserveLow`, `unreadable` and `stale`, with no amount; the watcher only prints the first two and alarms on `stale`, meaning live payments are on and nothing was read for over 45 minutes (a stopped worker cannot alert for itself). Staging runs the same check against the sandbox: if its `ALERT_WEBHOOK_URL` is the production channel, a sandbox balance under ₦1,000 alerts there every 6 hours; the text says `bachs-sandbox`, so it can be told apart.

## 3. The edge (once, then only through deploys)

- **The move** (one-off, about a minute of staging downtime): `staging-setup.md` → "Move an existing staging server to the edge Caddy". After it, staging and production share the edge.
- **Hand the edge folder to production's user:** only `ship-production.sh` updates the edge (spec §6.1), over `tipme-prod`'s SSH, so `sudo chown -R tipme-prod: /srv/tipme-edge` (keep `edge.env` mode 600). `edge.env` needs `PRODUCTION_API_HOST=api.usetipme.xyz`.
- **Every production ship** checks the new Caddyfile on the server (`caddy validate` with the server's `edge.env`) and reloads it only if valid; an invalid one stops the ship before production changes, and a failed reload puts the previous file back.
- **A changed `compose.edge.yml` is never applied by a ship** (it would restart the edge, and with it staging). The ship prints a NOTICE. Apply it by hand in a quiet moment, as `tipme-prod`:

  ```sh
  cp /srv/tipme-edge/incoming/compose.edge.yml /srv/tipme-edge/compose.edge.yml
  docker compose -p tipme-edge -f /srv/tipme-edge/compose.edge.yml up -d
  curl -sf https://api.usetipme.xyz/health/ready && curl -sf https://api.staging.usetipme.xyz/health/ready
  ```

  Both environments are unreachable for the few seconds the container takes to restart. The edge's log limit (10 MB, 3 files) lives in `compose.edge.yml`, so it lands with the first edge install or this manual `up -d`; the Caddyfile's log filter (health-check noise) lands with the next ship.

- **Never stop the edge for a staging problem.** Production shares it. Staging's deploy and rollback scripts re-attach staging's API to `edge-staging` themselves; fix staging there.

## 4. Aiven (owner, once)

Full steps in `remote-database.md` (its paths predate the production user: use `/srv/tipme-production`, not `/srv/tipme/production`).

1. Create the PostgreSQL 16 service and a database named `tipme`. **Plan (Q8, owner):** Startup (2 days of point-in-time restore) or Business (14 days). Record the choice here: _not chosen yet_.
2. Download the service's CA certificate to `/srv/tipme-production/db-ca.pem`.
3. Put `avnadmin`'s URL in `DATABASE_ADMIN_URL`, and the runtime and migrator URLs in `DATABASE_URL` and `MIGRATION_DATABASE_URL`, all with `sslmode=verify-full&sslrootcert=/run/secrets/db-ca.pem`. Set `MIGRATE_CONFIRM_DATABASE=tipme`.
4. Allow only the server's address in Aiven's IP allow-list.
5. **Roles:** nothing to run by hand. Every deploy runs the `db-roles` tool (`roles.sql` as `avnadmin`) before and after migrating; the first deploy creates `tipme_runtime`, `tipme_migrator` and `tipme_backup`.

## 5. Restore drill (owner, once before activation)

Aiven's backups replace staging's off-site copies (spec §6.9), so prove one opens:

1. In Aiven, **fork** the service from its latest backup (Service → Backups → Fork).
2. Open the fork with `psql` (its own URL and CA) and count rows in both the fork and production:
   ```sql
   SELECT (SELECT count(*) FROM profiles) AS profiles, (SELECT count(*) FROM tips) AS tips, (SELECT count(*) FROM ledger_entries) AS ledger_entries;
   ```
   The fork's counts must equal production's at the backup's time (production may have grown since).
3. **Delete the fork** (it is billed while it exists).
4. Record it here:

   | Date | Backup time | profiles / tips / ledger_entries (fork vs production) | Result | By  |
   | ---- | ----------- | ----------------------------------------------------- | ------ | --- |
   |      |             |                                                       |        |     |

## 6. External uptime ping

Besides the watcher, an outside service pings `https://api.usetipme.xyz/health/live` every minute (any free uptime monitor; it needs no secrets) and alerts the owner by email. `/health/live` is process liveness only, so a database outage shows in the watcher (readiness), not here.

## 7. Deploy, roll back, override

**Deploy:** Actions → **Deploy production** → Run workflow (branch `main`). The owner approves the `production` environment. The run:

1. `gate`: refuses a commit whose file tree has no full staging pass (`release/staging-full`), unless `override_reason` is filled in;
2. builds `tipme-app:<12-char sha>` once, ships the edge (validated, reloaded) and the image and files to `/srv/tipme-production/releases/<version>/`;
3. runs `deploy-production.sh` on the server: Redis (never restarted), `db-roles`, migrations as the migrator, `db-roles` again, the idle colour on the new version (×3), wait until `/health/release` shows it, record, stop the old colour (it fails readiness, drains 5 s, closes), replace `worker-a` then `worker-b`;
4. runs the release check, read-only, expecting the version and `bachs-live`; posts to Slack.

If the new colour never becomes healthy, it is stopped and the old colour keeps serving; nothing is recorded.

**Override** (only when staging cannot run the commit, e.g. a production-only fix): fill `override_reason` with a sentence a reviewer can check later. The reason and the override show in the job summary. Deploy the same commit to staging afterwards.

**Roll back** (no migration runs; the database stays on the newer schema, which the earlier release must accept):

```sh
ssh tipme-prod@<server>
/srv/tipme-production/live/scripts/rollback-production.sh            # the version before the current one
/srv/tipme-production/live/scripts/rollback-production.sh <version>  # an earlier one still on the server
```

Then roll back the web in Vercel (Deployments → the previous one → Instant Rollback) and run the release check with `--expect-version <old sha> --expect-provider bachs-live --expect-live <true|false>` (read-only, never `--full`). `--expect-live` must say what `production.env` says. The last 5 deployed versions and both colours' versions stay on the server.

**Rolling back past admin roles** weakens access with no warning: the schema stays, but the older code reads only the role. Personal removals stop applying, `issues.view` can again read email content and export it, `payments.recheck` can again run repairs, and serious actions run with one person and no alert. Review who holds what first (`admin-roles.md`), and treat Approvals as stopped: waiting requests just wait, then expire after the next deploy.

**A stuck lock** ("Another deploy or rollback is running"): check that no Deploy production run and no script is running, then `rm -rf /srv/tipme-production/releases/.deploy.lock`.

## 8. Evidence: the no-downtime rehearsal

`scripts/rehearse-production.sh` runs production's Compose file, the real edge Caddyfile and the real deploy and rollback scripts on local Docker, with a Postgres 16 stand-in that speaks only TLS (a throwaway CA, so `verify-full` is really checked) and roles made by the `db-roles` tool. k6 sends 30 reads/s for 90 s through the edge while version B is deployed over A and then rolled back to A. It passes only if no served read fails, readiness answers nothing but `503 draining`, and `/health/release` shows each switch (12 of 12 answers).

**One copy per colour locally** (production runs three): a laptop's Docker could not hold six API copies plus the rest (31 Oct 2026, the VM restarted under it). The switch is the same; the four missing upstream names stay unresolvable, as the stopped colour's are in production.

**Readiness is not counted as a failure.** A stopping copy answers `/health/ready` with `503 draining` on purpose (that is how Caddy learns to stop sending to it), and for up to one 2 s health-check interval Caddy still routes some requests to it. Those copies still serve every other request: in the same windows, release info and the database read had no failures.

**Not proven by it:** production-mode boot. Production's config refuses every payment provider until the payments plan adds `bachs-live`, so the rehearsal runs the API and workers in password-protected preview with the mock provider and mock mail, and reads only paths the preview gate leaves open (`/health/ready`, `/health/release`, `/health/backups`). Production mode is proven on launch day, step 2.

**Results** (31 October 2026, images from `fe35350`, 30 reads/s for 90 s, one copy per colour):

| Run | Served reads failed                              | Readiness `503 draining`                                    | Other failures | Switches seen                         | Result                                                                                                                                                  |
| --- | ------------------------------------------------ | ----------------------------------------------------------- | -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | —                                                | —                                                           | —              | —                                     | Did not run: the local Docker VM restarted three times and stopped answering while starting three copies per colour; run again with one copy per colour |
| 1   | 0 of 1,800                                       | 9                                                           | 0              | A → B → A                             | Failed under the first rule, which counted readiness: that is how the 503s were found                                                                   |
| 2   | 0 of 1,800                                       | 16 (16:58:43–44 and 16:59:09–10 UTC, one window per switch) | 0              | A → B → A                             | Same; each failure was logged with its status, all `503 {"status":"draining"}`                                                                          |
| 3   | 0 of 1,800 (`http_req_failed{served:yes}` 0.00%) | 9                                                           | 0              | A → B → A, deploy 25 s, rollback 26 s | **Pass**; every database connection TLS 1.3                                                                                                             |
| 4   | 0 of 1,800; 2,700 requests made                  | 31 (17:22:26–29 and 17:22:52–55 UTC)                        | 0              | A → B → A, deploy 25 s, rollback 21 s | **Pass** on the final settings (`health_fails 2`, `health_timeout 3s`, 7 s drain): each window is about 3 s, two failed checks long                     |

**Not done: the "must fail without the drain" run** on `8b2db32` (`REHEARSAL_REV=8b2db32 scripts/rehearse-production.sh`). It needs two more full image builds, the step that brought the local Docker down. Without it, these runs show the switch drops nothing; they do not show that the drain is what prevents drops. Run it on a machine with more room, and record the rate at which it fails, or that it did not.

To repeat: `scripts/rehearse-production.sh` (builds both images, about 5 minutes) or, with `tipme-app:aaaaaaa0001` and `tipme-app:bbbbbbb0002` already built, `REHEARSAL_PREBUILT=1 scripts/rehearse-production.sh` (about 3 minutes; keeps the images).

## 9. Launch day (spec §6.11)

The public site stays open with checkout closed (owner, 1 Nov), so everyone can reach it before and during these steps. The API is public too. Real tips are held back by the server: `PAYMENTS_LIVE_ENABLED` and `LIVE_CHECKOUT_HANDLES`, not by the site being hidden.

1. **Owner prerequisites:** the owner's answers to spec §9 (Q2–Q8); Aiven (§4 above) with its CA; ZeptoMail's production agent and webhook; the production R2 bucket (`photos.md`); the Bachs live key and webhook; the Vercel production variables (spec §6.8); the production Sentry DSN; a funded reserve; sections 1–3 and 5–6 of this runbook done.
2. **Setup deploy, not public,** with `PAYMENT_PROVIDER=bachs-live` and `PAYMENTS_LIVE_ENABLED=false`. This is the first boot in production mode (the rehearsal could not cover it): the API and workers must start, `/health/release` must report `deploymentMode: production`, `paymentProvider: bachs-live`, `paymentsLive: false`. The release check (read-only) passes, and the owner enrols in the admin area.
3. **Make ZeptoMail active** in Ops → Providers: send a test, open its link, switch.
4. **Verify the Bachs live webhook** with a real delivery: `live-activation.md`.
5. **Switch payments on for the owner's page only:** follow `live-activation.md` sections 4 and 5: set the repository variable and the env file (`PAYMENTS_LIVE_ENABLED=true`, `LIVE_CHECKOUT_HANDLES=<the owner's handle>`), deploy, then the ₦1,000 smoke tip and withdrawal.
6. **Widen checkout:** named recipients, then `*` as a separate decision (`live-activation.md` section 6), as Q7 decides.

### The pilot notice (web, Vercel)

The line "TipMe is in a pilot. Payments are real. Need help? support@usetipme.xyz" shows next to the money action when the web app has `PILOT_NOTICE=on` **and** this copy's payment mode is `live` (`/health/release` says `bachs-live` with live payments on). On a test copy, or while payments are still switched off (launch step 5), it shows nothing even with the variable set. The owner reviews the wording before activation.

- **When:** set `PILOT_NOTICE=on` and redeploy **before** launch step 5. It has no effect until payments are on, then appears with the first live page. Nothing to do at the switch itself.
- **Where it appears:** directly under the Tip button on a person's page; one line on the receipt after the status message; under the dashboard toolbar; and under "Available" on the Withdraw page. Not in the footer, not on the marketing and legal pages, and not on the pretend checkout.
- **How to set it:** Vercel → the `tipme` project → Settings → Environment Variables → **Production only**. Add `PILOT_NOTICE` = `on`. Unset, or any other value, means no notice.
- **It is a server setting, not a build one:** the web app reads it for each request, and it has no `NEXT_PUBLIC_` twin, so nothing about it reaches the browser bundle. Vercel still applies a changed variable only to a **new deployment**: after adding or removing it, **redeploy** (Deployments → the latest → Redeploy). Instant Rollback to an older deployment restores that deployment's value of the variable.
- **Check after step 5:** open `/@<a real handle>` (the line sits under the Tip button), a receipt and `/dashboard`; each shows it with a `mailto:support@usetipme.xyz` link. A brief API outage makes the web treat the copy as closed for a few seconds, and the line disappears with it.
- Search indexing is separate: leave `SITE_INDEXING` unset while this is a closed pilot.

## 10. Live updates: the edge and the flag (owner)

Live updates (spec `docs/superpowers/specs/2026-11-03-live-updates-design.md`) send signed-in dashboards a change signal over `GET /v1/me/events` (`text/event-stream`). They are off until `LIVE_UPDATES_ENABLED=true`; while off, the route answers 204 and pages behave as before.

1. **The edge.** The Caddyfile keeps `/v1/me/events` and `/v1/ops/events` out of `encode` (a compressed stream is held back until a buffer fills). The next production ship validates and reloads it (§3). To apply it before then, as `tipme-prod`:

   ```sh
   cp deploy/edge/Caddyfile /srv/tipme-edge/Caddyfile
   docker compose -f deploy/edge/compose.edge.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```

2. **Staging first.** Set `LIVE_UPDATES_ENABLED=true` in `/srv/tipme/staging.env` and recreate the API.
3. **Prove the stream through the edge** with a signed-in session cookie from staging (never paste it anywhere else):

   ```sh
   curl -N -H 'Cookie: tipme_session=…' https://$STAGING_API_HOST/v1/me/events
   ```

   It must print `retry: 5000`, then `data: {"type":"ready"}`, then `: hb` within 21 s, with no `Content-Encoding` header (`curl -N -D - …` shows the headers).

4. **Watch a week** of `tipme.live.*` on staging (`tipme.live.subscriber` stays 1; `tipme.live.connects{outcome}` shows few `limit_*` or `rate_limited`), then set `LIVE_UPDATES_ENABLED=true` in `production.env` and recreate the API colour.

**The new-tip sound on Safari and iPhone.** WebKit unlocks page audio per media element, through a click or key press on that element's play. The sound is created at the first tip, in a hidden tab, away from any gesture, so on Safari (macOS and every iPhone browser) it will mostly not play. It fails silently, as the owner accepted (DECISION-LOG, 3 Nov 2026). If it is wanted there, the fix is to create the audio element inside the first click or key press and prime it (muted play, then pause).

**To turn it off:** set `LIVE_UPDATES_ENABLED=false` in `production.env` and recreate the API colour. No web deploy is needed: the web app sees 204 and stops trying for that page load.

### Before deploying the reserved example handles

TipMe's own pages show six example handles, and they are reserved (`RESERVED_HANDLES`). If a real person already owns one, Home advertises that stranger's page. Run this on production before the deploy:

```sql
SELECT 'profile' AS kind, handle_lower, page_state FROM profiles
  WHERE handle_lower IN ('ada','adacuts','adaedits','adaokafor','tobi','zainab')
UNION ALL
SELECT 'alias', handle_lower, NULL FROM handle_aliases
  WHERE handle_lower IN ('ada','adacuts','adaedits','adaokafor','tobi','zainab');
```

**Stop rule:** if any row comes back, do not deploy, and tell the owner. The owner decides: drop that handle from the examples and the reserved list, or contact the person. No row means it is safe. (An owner who has one of these handles keeps the page and can rename back to it; only new claims are refused.)

### Never set the pretend-delivery switch in production

`NEXT_PUBLIC_PRETEND_DELIVERY` belongs to test copies only (the e2e stack, `review:screens`, local staging). In a production build it opens `/dev/inbox` (every sign-in code, readable by anyone) and `/dev/crash`. Production web must not set it; check the Vercel production environment before launch.

## 11. TipMe for businesses: turning it on and verifying the first business (owner)

Businesses (plan `docs/superpowers/plans/2026-11-06-business.md`, release 1) are off until `BUSINESS_ENABLED=true` on the API. While off, every business route answers 404, the web shows no Business or Work link, `/b/*` shows as unavailable, and a tip ignores any business label. Release 2's own flags (`BUSINESS_SHARES_ENABLED`, `TEAM_TIPS_ENABLED`) stay off; this section does not turn them on.

**Before turning it on:**

1. The privacy page on production (`/legal/privacy`) shows "If you tip at a business" and "If you work at a business", and `docs/00-DECISIONS.md` has "What a business sees". Both describe what the code shows; neither claims any approval.
2. At least **two** staff members hold `businesses.manage` and can enter an authenticator code (`docs/runbooks/admin-roles.md`). **A business's own managers can't verify it fairly:** approving is refused for them, but today a staff member who manages the business can still ask, and with nobody else qualified it runs alone (audited, alert sent). A separate PR refuses that request. Until it is on production, the person who verifies a business must not be one of its managers.

**Turning it on:**

3. **Staging first.** Set `BUSINESS_ENABLED=true` in `/srv/tipme/staging.env` and recreate the API. Check `curl -s https://$STAGING_API_HOST/health/release` shows `"business":true`. The web reads that answer; no web deploy is needed.
4. Walk the journey on staging: create a business from the navbar's "Businesses", verify it from `/ops/businesses` as a second staff member, invite someone by link, check them in, print the location sign, tip through it with the pretend partner, and see the count and note on the Business page.
5. Then set `BUSINESS_ENABLED=true` in `production.env` and recreate the API colour, and check `/health/release` on production the same way.

**Verifying the first business (staff, not one of its managers):**

6. Open `/ops/businesses`, then the business. Check its name, address and a contact against something outside TipMe (O2: no documents are uploaded). The contact shows masked; **Reveal** needs a reason and is audited. Each location links to its public page: before verification it reads "isn't taking tips on TipMe right now", which is expected.
7. **Verify this business** with a reason and a fresh code. With a second qualified person it waits for their approval; it runs alone only when nobody else qualifies, which the log and the alert record.
8. After verification the location page shows the verified line and the people on shift, and the owners can print their codes.

**To turn it off:** set `BUSINESS_ENABLED=false` and recreate the API colour. Business pages show as unavailable and tips go on as plain tips to each person; nothing is deleted, and a person's own data stays downloadable (`/v1/me/exports/work.csv`).

## Staff access

Add and remove staff in the dashboard: `docs/runbooks/admin-roles.md`. `pnpm ops:grant-owner` on the server is only for when every owner is locked out, and it is logged. Server access and GitHub deploy rights go around every role and approval, so keep them with very few people.
