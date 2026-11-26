# Runbook: setting up staging (one VPS)

**When:** once, when the VPS exists, and again if staging is ever rebuilt. Pretend money only.

**You need:**

- a VPS: Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM, 80 GB disk, in London or Frankfurt;
- your domain's DNS;
- this repository on GitHub.

Secrets are typed on the server, never into chat or the repository. (The website ran on Vercel until
26 Nov 2026; an existing server moves with "Website on this server: the move from Vercel" below.)

## 1. DNS

| Name                   | Type                             | Points to                             |
| ---------------------- | -------------------------------- | ------------------------------------- |
| `api.staging.<domain>` | A (and AAAA if the VPS has IPv6) | the VPS address                       |
| `staging.<domain>`     | A (and AAAA if the VPS has IPv6) | the VPS address (the website, step 4) |

## 2. Harden the server (as root, once)

1. **Create the deploy user:** `adduser --disabled-password deploy`; copy your SSH public key into `/home/deploy/.ssh/authorized_keys`.
2. **SSH:** in `/etc/ssh/sshd_config` set `PasswordAuthentication no` and `PermitRootLogin no`, then `systemctl restart ssh`. Log in again as `deploy` in a second window before closing the first.
3. **Firewall:** `ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw enable`.
4. **Updates:** `apt install unattended-upgrades fail2ban` and enable security updates.
5. **Docker:** install Docker Engine and the Compose plugin from Docker's apt repository, then `usermod -aG docker deploy`. Nothing else is needed: no git, no Node, no build tools.

   Note: Docker publishes ports past ufw. Only the edge Caddy (step 3a) publishes any (80/443), by design.

## 3. Lay out the files (as `deploy`)

The server never builds or holds the source code: GitHub Actions builds each version and ships it (step 5). The server needs only Docker, a settings file and a folder for backups.

```sh
sudo mkdir -p /srv/tipme/backups && sudo chown deploy: /srv/tipme && sudo chown 1000:1000 /srv/tipme/backups
# From your machine: scp deploy/staging.env.example deploy@<server>:/srv/tipme/staging.env
chmod 600 /srv/tipme/staging.env
```

Fill in `/srv/tipme/staging.env`:

- **Hosts:** the real host names.
- **Secrets**, using exactly these recipes (`deploy.sh` refuses a password that would break the database address):
  - `POSTGRES_PASSWORD`, `POSTGRES_RUNTIME_PASSWORD`, `POSTGRES_MIGRATOR_PASSWORD` and `POSTGRES_BACKUP_PASSWORD`: four different values from `openssl rand -hex 32`;
  - `OPS_TOTP_KEY` and `BACKUP_KEY`: `openssl rand -base64 32` (exactly 32 bytes);
  - other TipMe-managed secrets: `openssl rand -base64 48`.
- **Bachs sandbox credentials** are provider-issued, not generated: use only an `sk_sandbox_` API key and the webhook signing secret configured for the sandbox endpoint. Keep `BACHS_PREVIOUS_WEBHOOK_SECRET` empty except during signing-secret rotation.
- Keep the Postgres passwords distinct. The API and worker receive only `POSTGRES_RUNTIME_PASSWORD`; migrations receive `POSTGRES_MIGRATOR_PASSWORD`; scheduled backups receive `POSTGRES_BACKUP_PASSWORD` (read-only plus replication); only the one-shot restore service receives the `POSTGRES_PASSWORD` admin credential.
- For an existing database volume, the deploy script provisions these roles and moves existing application objects to the migration owner before taking its first backup, then grants the backup role access to newly migrated objects. Do not manually reset the volume or change `POSTGRES_PASSWORD`.
- **`BACKUP_KEY`:** save a copy off the server, in your password manager. Without it no backup can be read.
- **`RELEASE_KIND=test`:** this copy runs the full release check.

To test Bachs checkout in this isolated staging copy, set `PAYMENT_PROVIDER=bachs-sandbox` and populate `BACHS_SANDBOX_API_KEY` and `BACHS_WEBHOOK_SECRET` in `/srv/tipme/staging.env`, then redeploy. The staging Compose file forwards the API key to the API and worker, and the webhook secrets to the API only (the worker only reads statuses). Keep `DEPLOYMENT_MODE=preview`, the shared `PREVIEW_PASSWORD`, and `PAYMENTS_LIVE_ENABLED=false`; never put Bachs credentials in the web app or configure a live key. The default remains `PAYMENT_PROVIDER=mock`.

### How a Bachs tip gets confirmed

Three paths, fastest first; any one of them is enough, and each reads the payment back from Bachs with the same checks:

1. **Webhook** (instant). In Bachs' dashboard the staging endpoint (`https://api.staging.usetipme.xyz/v1/webhooks/bachs`) must be enabled and subscribed to payment events on **connected accounts**: at least `collection.succeeded`, `collection.failed`, `checkout.completed` and `checkout.expired`, plus `account.updated` and `capability.updated`. Bachs' `GET /v1/webhooks/events` lists each event with its delivery attempts; `attempts: 0` means Bachs never sent it.
2. **The open receipt** (seconds). When the supporter comes back from Bachs, the receipt's status request asks Bachs directly, at most once every 4 seconds per tip.
3. **The worker** (about a minute). It checks unfinished tips every 20 seconds once they are 45 seconds old, in case the supporter closed the page.

### The release check on the Bachs sandbox

A new page cannot take Bachs tips until its owner completes Bachs' own form, so the release check cannot tip the page it creates. On a Bachs copy it instead:

- checks that its new page says "can't receive tips just yet" and that its owner is told to set up payments;
- tips a **standing test page, `@release_bachs`**, and passes once Bachs' sandbox checkout opens for that tip. It never pays: that would depend on Bachs' own page. The unpaid checkout expires, and paid totals do not move;
- skips the pretend-only steps (the misreported amount, covered by the integration tests, and the withdrawal, since Bachs money cannot be withdrawn yet).

Set up `@release_bachs` once, in a browser, with the staging password:

1. Sign up with a phone number kept for this page only (codes arrive in the pretend inbox), and claim the handle `release_bachs`.
2. Add a name, confirm an email address (payment setup needs one), then go to **Settings → Test payments → Set up test payments** (country `NG`, Individual) and complete Bachs' sandbox form.
3. Back in Settings, the card should read "Ready to receive test tips". Make the page live.

Without it, the release check stops in seconds and names the page; `RELEASE_BACHS_HANDLE` names a different page.

### Bachs sandbox webhook endpoint

1. In the Bachs sandbox Dashboard, add a webhook endpoint `https://<api-host>/v1/webhooks/bachs`. Its `event_source` is one of `account` (TipMe's own account only), `connect` (connected accounts only) or `all`; there is no `connect/all`. Tips are direct charges on recipients' connected accounts, so it needs `connect` at least; paid Pro needs `all`, because Pro is bought on TipMe's own account (ADR-0015).
   - **Order matters for `all`:** first deploy the release that routes own-account events to Pro billing and set `BACHS_PLATFORM_ORGANIZATION_ID` to TipMe's own sandbox organization (`acct_stWbI4933A4WVqkc` as of 9 Nov 2026; `GET /v1/balances` names it), then switch the endpoint to `all`. Switched first, TipMe's own events would be read as a connected account's and land unmatched in the tip path.
   - Own-account events have no top-level `account` field; connected-account events do. Own-account `account.updated` and payout events are ignored.
2. Subscribe to `checkout.completed`, `collection.succeeded`, `collection.failed`, `collection.underpaid`, `account.updated`, `capability.updated`, and every refund, dispute and chargeback event Bachs offers. Refunds and disputes are not modelled yet: each one opens a "Refund or dispute reported" money issue and changes no balance.
3. Copy the endpoint's signing secret into `BACHS_WEBHOOK_SECRET` and redeploy the API.
4. Send a test event from the Dashboard and confirm the API logs `webhook.processed` (a test event for an unknown account is stored as unmatched, which is expected). A `webhook.rejected` log means the secret or clock is wrong.
5. Failed deliveries can be replayed from the Dashboard: delivery is idempotent, and account events simply re-read the account from Bachs.
6. Before each test session, check the platform balance in the Dashboard. TipMe pays Bachs' processing fee; if the balance cannot cover it, Bachs silently charges the recipient. Those payments stay pending in TipMe and surface as issues, but there is no automated reserve alert yet.

### Paid Pro in the sandbox (ADR-0015)

Pro is bought on TipMe's **own** partner account, not a recipient's. To try a whole purchase on staging with test money:

1. Deploy the release with paid Pro. Set `BACHS_PLATFORM_ORGANIZATION_ID` (TipMe's own sandbox organization) on the API and redeploy, then turn on **Pro billing** at `/ops/switches` (a money switch: a second person approves).
2. Only then switch the sandbox webhook endpoint to `event_source=all` (see above), and subscribe it to `collection.succeeded`, `checkout.completed`, `collection.failed` and the refund events.
3. Signed in as a recipient, `POST /v1/me/pro/purchases` with `{"expectedAmountMinor":"250000"}` and an `Idempotency-Key` (there is no buy screen yet). Open the returned `checkoutUrl` and pay with the partner's sandbox test card, or by sandbox bank transfer.
4. Expect, within seconds: the purchase `PAID`, one `pro.<purchaseId>` ledger transaction, a Pro month in `pro_periods`, the page on Pro, and a `pro_receipt` email. Coming back from the checkout alone changes nothing; only the partner's confirmed payment does.
5. `scripts/pro-sandbox-check.mjs --sandbox` opens one ₦2,500 sandbox checkout through TipMe's adapter and prints it, without the database or the webhook: a quick check of the partner side only.

The image runs as uid 1000 and writes backups into `/srv/tipme/backups` (hence the `chown` above; `deploy.sh` checks it).

Off-site copies are optional. If enabling rclone, create `/srv/tipme/offsite.env` with mode 600 and put only `BACKUP_RCLONE_REMOTE` and the relevant `RCLONE_CONFIG_<NAME>_*` settings there. The offsite container reads this file only; do not add bucket credentials to `staging.env`.

## 3a. The edge Caddy (once, as `deploy`)

One Caddy, in its own Compose project `tipme-edge`, owns ports 80 and 443 for staging and production. Deploying or stopping either environment never touches it. Do this before the first deploy (`deploy.sh` refuses to run without the `edge-staging` network).

```sh
sudo mkdir -p /srv/tipme-edge && sudo chown deploy: /srv/tipme-edge
# From your machine: scp deploy/edge/{Caddyfile,compose.edge.yml,setup-networks.sh,edge.env.example} deploy@<server>:/srv/tipme-edge/
cd /srv/tipme-edge && cp edge.env.example edge.env && chmod 600 edge.env   # fill in the three names
bash setup-networks.sh                                                       # creates edge-staging and edge-production
docker compose -p tipme-edge -f compose.edge.yml up -d
```

`edge.env` holds `ACME_EMAIL`, `STAGING_API_HOST`, `PRODUCTION_API_HOST`, `STAGING_WEB_HOST`, `PRODUCTION_WEB_HOST` and `PRODUCTION_APEX_HOST` (the Caddyfile refuses to load without any of them). Until production exists, none of the production containers (`tipme-production-api-{blue,green}-{1,2,3}`, `tipme-production-web-{blue,green}-1`) exist, so the production hosts return 502; that is expected.

## 4. The website (on this server)

Nothing to install: each deploy builds the website's image in GitHub Actions (`tipme-web-staging:<version>`, `deploy/web.Dockerfile`) and runs it as the `web` service beside the API; the edge serves it at `staging.<domain>`. What it reads (`apps/web/DEPLOYMENT.md` has the full tables):

- **From `staging.env`** (names only; the API reads the same lines): `PREVIEW_PASSWORD`, `PREVIEW_COOKIE_DOMAIN=staging.<domain>`, `WEB_REVALIDATE_SECRET`, and `WEB_REVALIDATE_URL=https://staging.<domain>/api/revalidate` (the public address: the worker is not on the edge network). Optional and deprecated: `PILOT_NOTICE`; `PRODUCTION_LAUNCH_AT` only if a countdown is not set in admin.
- **From GitHub variables** (baked in at build, step 5): `STAGING_WEB_URL` (the site's address), `STAGING_API_URL` (the API's), and the optional `STAGING_NEXT_PUBLIC_*` settings.
- It reaches the API over the edge network (`http://staging-api:4000`), never through the internet.

## 5. GitHub: let Actions deploy

1. **Make a key just for Actions** (on your machine):

   ```sh
   ssh-keygen -t ed25519 -f tipme-actions -N '' -C tipme-actions
   ```

   Append `tipme-actions.pub` to `/home/deploy/.ssh/authorized_keys` on the server.

2. **Pin the server's identity:** run `ssh-keyscan <server address>`, check the fingerprint against the server's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), and keep the output.
3. **Create the environment:** in the repository, **Settings → Environments → New environment** `staging` (optionally require your approval).
   - **Secrets:**
     - `STAGING_SSH_KEY`: the private key file `tipme-actions`;
     - `STAGING_SSH_KNOWN_HOSTS`: the `ssh-keyscan` output;
     - `RELEASE_PREVIEW_PASSWORD` and `RELEASE_CHECK_TOKEN`: the same values as the server;
     - `SLACK_WEBHOOK_URL` (optional): Slack Incoming Webhook URL to receive deployment alerts and product/fix summaries.
   - **Variables:**
     - `STAGING_SSH` = `deploy@<server address>`;
     - `STAGING_WEB_URL` = `https://staging.<domain>`;
     - `STAGING_API_URL` = `https://api.staging.<domain>`;
     - the website's build settings, all optional (each default is what staging had on Vercel): `STAGING_NEXT_PUBLIC_SENTRY_DSN` (the `tipme-web` DSN; blank sends nothing), `STAGING_NEXT_PUBLIC_SENTRY_ENVIRONMENT` (default `staging`), `STAGING_NEXT_PUBLIC_PREVIEW_GATE` (default `on`), `STAGING_NEXT_PUBLIC_PRETEND_DELIVERY` (default `on`);
     - `STAGING_AUTO_DEPLOY` = `true` to deploy every push to `dev` once its checks pass. The workflow reads this inside the environment, in a small `gate` job; a job's own `if:` cannot see environment variables.
   - **Slack:** every deploy posts its result. A run that stops because its checks failed posts too, from the `notify-stopped` job. Nothing is posted when auto-deploy is off or for pull-request runs.
   - **Alerts (PR-011):** add `STAGING_WEB_URL` and `STAGING_API_URL` **also as repository variables** (Settings → Secrets and variables → Actions → Variables → Repository), and optionally the **repository secret** `ALERT_WEBHOOK_URL` (a Slack or Telegram-bridge webhook). The watcher uses repository-level settings so an approval rule on the `staging` environment never holds it up. **Staging watch** then runs every 15 minutes and fails (GitHub emails you) when the API or web app is down, live payments are on, a backup is over 26 hours old, WAL was not archived in the last 15 minutes or archiving failed in the last hour. The staging worker, when it runs the Bachs sandbox, also checks the sandbox reserve every 15 minutes and posts to `ALERT_WEBHOOK_URL` if that is set in the staging env file (it is unset by default; log only). Pointing it at the production channel means a sandbox balance under ₦1,000 alerts there every 6 hours, as `bachs-sandbox`; use a separate channel, or leave it unset.
4. **Delete the private key file** from your machine once it is stored in GitHub.

## 6. First deploy

**Actions → Deploy staging → Run workflow.** It:

1. runs every check;
2. builds `tipme-app:<version>` and `tipme-web-staging:<version>`;
3. sends both and that version's deploy files to the server;
4. deploys (backup → guarded migrate → switch the API, worker and website → health: the API's `/health/release` and the website's `/api/version` both show the version);
5. runs the release check (read-only until step 7 is done).

**First-run checks:**

- The edge Caddy has certificates for the API and website hosts: `docker compose -p tipme-edge logs caddy`.
- `https://api.staging.<domain>/health/release` and `https://staging.<domain>/api/version` show the version.
- `docker stats` stays well under the server's memory. Locally the stack idles at about 310 MB. With no builds on the server, 2 GB of memory is workable; 4 GB leaves headroom.

## 7. The release check's staff account (once)

```sh
/srv/tipme/live/scripts/compose.sh run --rm -e TIPME_CONFIRM_DATABASE=tipme migrate \
  node packages/database/dist/scripts/grant-owner.js --email <an address you keep for this> --role release_check
```

Then, on your machine within 30 minutes:

```sh
RELEASE_PREVIEW_PASSWORD=... RELEASE_CHECK_TOKEN=... node scripts/release-enrol.mjs \
  --web https://staging.<domain> --api https://api.staging.<domain> \
  --email <same address> --code <the enrolment code> --out ./release-totp.txt
```

(The pretend inbox on staging needs the release token as well as the password. Testers open `/dev/inbox` and enter the same token as the "Inbox key".)

Add the secret from `release-totp.txt` as `RELEASE_OPS_TOTP_SECRET` (then delete the file), and the address as `RELEASE_OPS_EMAIL`, to the GitHub `staging` environment (and your password manager). From then on every deploy runs the **full** check. Grant yourself the Owner role the same way (without `--role`) to use `/ops`.

## 8. Prove it

```sh
pnpm release:check --web https://staging.<domain> --api https://api.staging.<domain> --full
```

Then run the restore drill ([backup-and-restore](backup-and-restore.md)) and one rollback ([deploy-and-rollback](deploy-and-rollback.md)).

### Live updates

Staging turns live updates on first: `LIVE_UPDATES_ENABLED=true` in `staging.env`, then the `curl -N` check in [production §10](production.md#10-live-updates-the-edge-and-the-flag-owner).

## Move an existing staging server to the edge Caddy (one-off)

**When:** once, on a server whose staging project still runs its own Caddy (any version before the edge). Plan about a minute of staging downtime: only one Caddy can hold ports 80/443, so there is a short gap while one stops and the other starts. Postgres, Redis, the worker and the API keep running.

1. **Ship the edge files** as in step 3a (copy, fill `edge.env` with the same API host and ACME email staging already uses, run `setup-networks.sh`). Do not start the edge yet.
2. **Copy the certificates once**, so Let's Encrypt is not asked again (it rate-limits). The edge owns its own volumes; this only seeds them:

   ```sh
   docker volume create tipme-edge_caddy_data
   docker run --rm -v tipme-staging_caddy_data:/from -v tipme-edge_caddy_data:/to alpine cp -a /from/. /to/
   ```

3. **Put the running API on the edge network** under its new name, so the edge can reach it before any new deploy:

   ```sh
   docker network connect --alias staging-api edge-staging tipme-staging-api-1
   ```

   (`docker ps --format '{{.Names}}' | grep api` if the container is named differently.)

4. **Swap the Caddys** (the gap lasts the few seconds this takes):

   ```sh
   docker compose -p tipme-staging stop caddy && docker compose -p tipme-edge -f /srv/tipme-edge/compose.edge.yml up -d
   ```

5. **Check:** `curl -sf https://api.staging.<domain>/health/ready`, and `docker compose -p tipme-edge logs caddy` shows no certificate request (it found the copied one).
6. **Deploy the next staging version** from GitHub as usual. It defines no Caddy, so it never starts one and `--remove-orphans` clears the stopped old container; its API joins `edge-staging` itself. Do not deploy a new version before step 4: with the old Caddy gone and the edge not yet up, the deploy's health wait fails and it rolls back.
7. **Clean up** once it works: `docker volume rm tipme-staging_caddy_data tipme-staging_caddy_config`.

**Rolling back across the move:** versions from before the move put the API on the old `edge` network only. `deploy.sh` and `rollback.sh` attach the running API to `edge-staging` as `staging-api` after every start (including the automatic restore of the previous version), so the edge reaches it with no manual step. Never stop the edge Caddy for a staging problem: production shares it.

## Website on this server: the move from Vercel (one-off, 26 Nov 2026)

**When:** once, on a staging server whose website was on Vercel (Vercel paused the project: `402 Payment required`). Do this before production's move (`production.md`, section 13): it gives the edge its new settings and Caddyfile, which production's deploys keep after that. Names only below; type values on the server or in GitHub, never in chat.

**Plan the production deploy for soon after.** Step 4 points `www.<domain>` and the bare domain at the server too. From then until production's first deploy with the website (section 13), both answer `502` (they answered `402` under Vercel's pause). Schedule production's move for right after staging's full release check passes, so the gap is hours, not days.

1. **Merge this change to `dev`**, but leave staging's auto-deploy off for now (`STAGING_AUTO_DEPLOY` not `true`), so nothing deploys before step 6. A deploy before the edge has the site fails its website check and puts the previous version back.
2. **GitHub variables** (Settings → Environments → `staging`, or repository variables): check that `STAGING_WEB_URL` (`https://staging.<domain>`) and `STAGING_API_URL` are set. Optionally add `STAGING_NEXT_PUBLIC_SENTRY_DSN` (the `tipme-web` DSN that Vercel had as `NEXT_PUBLIC_SENTRY_DSN`). The other three `STAGING_NEXT_PUBLIC_*` default to Vercel's staging values. No new secrets.
3. **`/srv/tipme/staging.env`** (as `deploy`): these lines must be present. Count each by name:

   ```sh
   cd /srv/tipme
   for n in WEB_ORIGIN WEB_REVALIDATE_URL WEB_REVALIDATE_SECRET PREVIEW_PASSWORD PREVIEW_COOKIE_DOMAIN; do
     echo "$n $(grep -c "^$n=.\+" staging.env)"
   done
   ```

   Each must print `1`. They already exist for the API, and the website's deploy now stops if `PREVIEW_PASSWORD` is missing. `WEB_REVALIDATE_URL` stays `https://staging.<domain>/api/revalidate`. If Vercel's staging project had `PILOT_NOTICE` or `PRODUCTION_LAUNCH_AT` and `/ops/switches` has not set them, add the same line here; otherwise leave them out.

4. **DNS, for all three website names at once.** Move staging's and production's names together, so the edge never asks for a certificate while a name still points at Vercel (a failed challenge makes Caddy back off for hours and counts against Let's Encrypt's limits). At your DNS provider, for each of `staging.<domain>`, `www.<domain>` and the bare `<domain>`:
   - remove Vercel's record (a CNAME to Vercel, or Vercel's A/AAAA on the bare domain);
   - add an A record (and AAAA if the server has IPv6) for the server's address.

   Touch nothing else: the bare domain's MX, SPF, DKIM and DMARC records stay. If the domain has a CAA record, it must allow `letsencrypt.org`. Wait until each `dig +short <name>` shows the server's address. Until the edge has these sites (step 5), the names fail to connect, as they failed under Vercel's pause.

5. **The edge** (as `tipme-prod`, which owns `/srv/tipme-edge`). The edge container reads `edge.env` only when it is created, so this step **recreates** it; `caddy reload` alone would load the new hosts empty.

   1. Add three lines to `/srv/tipme-edge/edge.env` (names from `deploy/edge/edge.env.example`): `STAGING_WEB_HOST=staging.<domain>`, `PRODUCTION_WEB_HOST=www.<domain>` and `PRODUCTION_APEX_HOST=<domain>`. Add all three now: the new Caddyfile refuses to load without any of them.
   2. Copy the new Caddyfile over and check it with the new `edge.env`:

      ```sh
      # From your machine, at the merged commit:
      scp deploy/edge/Caddyfile tipme-prod@<server>:/srv/tipme-edge/incoming/Caddyfile
      # On the server, as tipme-prod:
      cd /srv/tipme-edge
      docker run --rm --env-file edge.env -v /srv/tipme-edge/incoming:/etc/caddy:ro caddy:2.10.2-alpine \
        caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
      ```

      It must print `Valid configuration`. If not, stop here: nothing has changed yet.

   3. Put it in place and recreate the edge. **Both APIs (staging and production) are unreachable for the few seconds the container takes to restart**, so do it in a quiet moment:

      ```sh
      cd /srv/tipme-edge
      cp Caddyfile Caddyfile.previous
      cat incoming/Caddyfile > Caddyfile
      docker compose -p tipme-edge -f compose.edge.yml up -d
      docker compose -p tipme-edge -f compose.edge.yml exec -T caddy printenv STAGING_WEB_HOST
      curl -sf https://api.staging.<domain>/health/ready && curl -sf https://api.usetipme.xyz/health/ready && echo APIs-ok
      ```

      `cat … > Caddyfile` writes the file in place, because the container mounts this one file. `printenv` must print the staging host: the recreated edge has the new settings. The certificates stay in the edge's volume.

   4. The edge now asks for the three new certificates. Within a minute or two, check `docker compose -p tipme-edge -f compose.edge.yml logs caddy | grep -iE 'certificate obtained|error'`. If one failed (DNS had not reached every resolver yet), ask again once `dig` agrees: `docker compose -p tipme-edge -f compose.edge.yml exec -T caddy caddy reload --force --config /etc/caddy/Caddyfile`. A reload is enough here: the settings are already in the container.

   If anything in this step goes wrong, go back to the old file with `cat Caddyfile.previous > Caddyfile` and `docker compose -p tipme-edge -f compose.edge.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile`. A reload is enough for that: the old file needs none of the new settings.

6. **Deploy:** Actions → **Deploy staging** → Run workflow (branch `dev`). It builds and ships both images, starts `web`, waits until `https://staging.<domain>/api/version` shows the version, then runs the full release check against the self-hosted site. Turn `STAGING_AUTO_DEPLOY` back on afterwards if it was on.
7. **Verify** (from your machine):

   ```sh
   curl -sI https://staging.<domain>/ | grep -iE '^HTTP|^location|^strict-transport|^content-security'
   curl -s https://staging.<domain>/api/version
   curl -s https://api.staging.<domain>/health/release | grep -o '"version":"[^"]*"'
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://staging.<domain>/api/revalidate \
     -H 'content-type: application/json' -d '{"handle":"nobody","secret":"wrong"}'
   ```

   Expect, in order: a `303` to `/preview-login` with HSTS and CSP; `{"version":"<12-character sha>"}`; the same sha from the API; `401` (the route is reachable and checks its secret).

   In a browser: enter the preview password, sign in (codes at `/dev/inbox`), open a tip page (`/@<a handle>`) and its pictures, then change something on that page in the dashboard and see the public page show it within seconds (the revalidate call). On the server:
   - `TIPME_STACK=staging /srv/tipme/live/scripts/compose.sh ps web` shows `healthy`;
   - `docker stats --no-stream` shows `tipme-staging-web-1` well under 768 MB;
   - `TIPME_STACK=staging /srv/tipme/live/scripts/compose.sh logs api | grep -c revalidate_failed` stays `0` after the page change.

8. **Rolling back:** `rollback.sh` moves the website with the API, but refuses a version from before the website ran here (that version's compose file has no website, so going back to it would stop the site). Until two versions with the website have been deployed, a broken website is fixed forward. To take the website hosts off the edge entirely (they then fail as they did under Vercel's pause; the APIs keep serving), put the old Caddyfile back and reload, as at the end of step 5.
