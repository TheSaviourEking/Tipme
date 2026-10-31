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

  Both environments are unreachable for the few seconds the container takes to restart.

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

Then roll back the web in Vercel (Deployments → the previous one → Instant Rollback) and run the release check with `--expect-version <old sha>` (read-only, never `--full`). The last 5 deployed versions and both colours' versions stay on the server.

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

**Not done: the "must fail without the drain" run** on `8b2db32` (`REHEARSAL_REV=8b2db32 scripts/rehearse-production.sh`). It needs two more full image builds, the step that brought the local Docker down. Without it, these runs show the switch drops nothing; they do not show that the drain is what prevents drops. Run it on a machine with more room, and record the rate at which it fails, or that it did not.

To repeat: `scripts/rehearse-production.sh` (builds both images, about 5 minutes) or, with `tipme-app:aaaaaaa0001` and `tipme-app:bbbbbbb0002` already built, `REHEARSAL_PREBUILT=1 scripts/rehearse-production.sh` (about 3 minutes; keeps the images).

## 9. Launch day (spec §6.11)

`usetipme.xyz` keeps the countdown page until step 6; nobody outside sees production before then.

1. **Owner prerequisites:** the owner's answers to spec §9 (Q2–Q8); Aiven (§4 above) with its CA; ZeptoMail's production agent and webhook; the production R2 bucket (`photos.md`); the Bachs live key and webhook; the Vercel production variables (spec §6.8); the production Sentry DSN; a funded reserve; sections 1–3 and 5–6 of this runbook done.
2. **Setup deploy, not public,** with `PAYMENT_PROVIDER=bachs-live` and `PAYMENTS_LIVE_ENABLED=false`. This is the first boot in production mode (the rehearsal could not cover it): the API and workers must start, `/health/release` must report `deploymentMode: production`, `paymentProvider: bachs-live`, `paymentsLive: false`. The release check (read-only) passes, and the owner enrols in the admin area.
3. **Make ZeptoMail active** in Ops → Providers: send a test, open its link, switch.
4. **Verify the Bachs live webhook** with a real delivery: `live-activation.md`.
5. **Switch payments on:** `PAYMENTS_LIVE_ENABLED=true`, deploy, set the repository variable `PRODUCTION_PAYMENTS_LIVE=true`, then the ₦1,000 smoke tip to the owner's page, confirmed and withdrawn: `live-activation.md`.
6. **Open the site:** `usetipme.xyz` switches from the countdown to TipMe, as Q7 decides (public, or the pilot first).
