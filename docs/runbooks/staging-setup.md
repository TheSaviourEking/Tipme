# Runbook: setting up staging (VPS + Vercel)

**When:** once, when the VPS exists, and again if staging is ever rebuilt. Pretend money only.

**You need:**

- a VPS: Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM, 80 GB disk, in London or Frankfurt;
- your domain's DNS;
- a Vercel account;
- this repository on GitHub.

Secrets are typed on the server or into Vercel, never into chat or the repository.

## 1. DNS

| Name                   | Type                             | Points to                                                |
| ---------------------- | -------------------------------- | -------------------------------------------------------- |
| `api.staging.<domain>` | A (and AAAA if the VPS has IPv6) | the VPS address                                          |
| `staging.<domain>`     | CNAME                            | the target Vercel shows when you add the domain (step 4) |

## 2. Harden the server (as root, once)

1. **Create the deploy user:** `adduser --disabled-password deploy`; copy your SSH public key into `/home/deploy/.ssh/authorized_keys`.
2. **SSH:** in `/etc/ssh/sshd_config` set `PasswordAuthentication no` and `PermitRootLogin no`, then `systemctl restart ssh`. Log in again as `deploy` in a second window before closing the first.
3. **Firewall:** `ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw enable`.
4. **Updates:** `apt install unattended-upgrades fail2ban` and enable security updates.
5. **Docker:** install Docker Engine and the Compose plugin from Docker's apt repository, then `usermod -aG docker deploy`. Nothing else is needed: no git, no Node, no build tools.

   Note: Docker publishes ports past ufw. Only Caddy publishes any (80/443), by design.

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

### Bachs sandbox webhook endpoint

1. In the Bachs sandbox Dashboard, add a webhook endpoint `https://<api-host>/v1/webhooks/bachs` with `event_source=connect/all`, so events from recipients' connected accounts reach TipMe (direct charges are made on those accounts).
2. Subscribe to `checkout.completed`, `collection.succeeded`, `collection.failed`, `collection.underpaid`, `account.updated`, `capability.updated`, and every refund, dispute and chargeback event Bachs offers. Refunds and disputes are not modelled yet: each one opens a "Refund or dispute reported" money issue and changes no balance.
3. Copy the endpoint's signing secret into `BACHS_WEBHOOK_SECRET` and redeploy the API.
4. Send a test event from the Dashboard and confirm the API logs `webhook.processed` (a test event for an unknown account is stored as unmatched, which is expected). A `webhook.rejected` log means the secret or clock is wrong.
5. Failed deliveries can be replayed from the Dashboard: delivery is idempotent, and account events simply re-read the account from Bachs.
6. Before each test session, check the platform balance in the Dashboard. TipMe pays Bachs' processing fee; if the balance cannot cover it, Bachs silently charges the recipient. Those payments stay pending in TipMe and surface as issues, but there is no automated reserve alert yet.

The image runs as uid 1000 and writes backups into `/srv/tipme/backups` (hence the `chown` above; `deploy.sh` checks it).

Off-site copies are optional. If enabling rclone, create `/srv/tipme/offsite.env` with mode 600 and put only `BACKUP_RCLONE_REMOTE` and the relevant `RCLONE_CONFIG_<NAME>_*` settings there. The offsite container reads this file only; do not add bucket credentials to `staging.env`.

## 4. Vercel (web app)

1. **New Project** → import the GitHub repo → **Root Directory** `apps/web`. `apps/web/vercel.json` sets the install and build commands.
2. **Environment variables** (Production and Preview):
   - `NEXT_PUBLIC_API_ORIGIN` and `API_INTERNAL_ORIGIN` = `https://api.staging.<domain>`;
   - `NEXT_PUBLIC_PRETEND_DELIVERY=on`;
   - `NEXT_PUBLIC_PREVIEW_GATE=on`;
   - `SITE_URL=https://staging.<domain>`;
   - `PREVIEW_PASSWORD` and `WEB_REVALIDATE_SECRET`, the **same values** as the server;
   - `PREVIEW_COOKIE_DOMAIN=staging.<domain>`.
3. **Domains** → add `staging.<domain>` and set the CNAME from step 1.
4. **Node.js version:** 24.x.

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
     - `STAGING_AUTO_DEPLOY` = `true` to deploy every push to `dev` once its checks pass. The workflow reads this inside the environment, in a small `gate` job; a job's own `if:` cannot see environment variables.
   - **Slack:** every deploy posts its result. A run that stops because its checks failed posts too, from the `notify-stopped` job. Nothing is posted when auto-deploy is off or for pull-request runs.
   - **Alerts (PR-011):** add `STAGING_WEB_URL` and `STAGING_API_URL` **also as repository variables** (Settings → Secrets and variables → Actions → Variables → Repository), and optionally the **repository secret** `ALERT_WEBHOOK_URL` (a Slack or Telegram-bridge webhook). The watcher uses repository-level settings so an approval rule on the `staging` environment never holds it up. **Staging watch** then runs every 15 minutes and fails (GitHub emails you) when the API or web app is down, live payments are on, a backup is over 26 hours old, WAL was not archived in the last 15 minutes or archiving failed in the last hour.
4. **Delete the private key file** from your machine once it is stored in GitHub.

## 6. First deploy

**Actions → Deploy staging → Run workflow.** It:

1. runs every check;
2. builds `tipme-app:<version>`;
3. sends it and that version's deploy files to the server;
4. deploys (backup → guarded migrate → switch → health);
5. runs the release check (read-only until step 7 is done).

**First-run checks:**

- Caddy obtains a certificate: `/srv/tipme/live/scripts/compose.sh logs caddy`.
- `https://api.staging.<domain>/health/release` shows the version.
- `docker stats` stays well under the server's memory. Locally the stack idles at about 310 MB. With no builds on the server, 2 GB of memory is workable; 4 GB leaves headroom.

## 7. The release check's staff account (once)

```sh
/srv/tipme/live/scripts/compose.sh run --rm -e TIPME_CONFIRM_DATABASE=tipme migrate \
  node packages/database/dist/scripts/grant-owner.js --phone <a number you keep for this> --role release_check
```

Then, on your machine within 30 minutes:

```sh
RELEASE_PREVIEW_PASSWORD=... RELEASE_CHECK_TOKEN=... node scripts/release-enrol.mjs \
  --web https://staging.<domain> --api https://api.staging.<domain> \
  --phone <same number> --code <the enrolment code> --out ./release-totp.txt
```

(The pretend inbox on staging needs the release token as well as the password. Testers open `/dev/inbox` and enter the same token as the "Inbox key".)

Add the secret from `release-totp.txt` as `RELEASE_OPS_TOTP_SECRET` (then delete the file), and the number as `RELEASE_OPS_PHONE`, to the GitHub `staging` environment (and your password manager). From then on every deploy runs the **full** check. Grant yourself the Owner role the same way (without `--role`) to use `/ops`.

## 8. Prove it

```sh
pnpm release:check --web https://staging.<domain> --api https://api.staging.<domain> --full
```

Then run the restore drill ([backup-and-restore](backup-and-restore.md)) and one rollback ([deploy-and-rollback](deploy-and-rollback.md)).
