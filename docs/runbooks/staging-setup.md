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
5. **Docker:** install Docker Engine and the Compose plugin from Docker's apt repository, then `usermod -aG docker deploy`.

   Note: Docker publishes ports past ufw. Only Caddy publishes any (80/443), by design.

## 3. Lay out the files (as `deploy`)

```sh
sudo mkdir -p /srv/tipme && sudo chown deploy: /srv/tipme
git clone git@github.com:<you>/Tipme.git /srv/tipme/app   # a read-only deploy key on the repo
cp /srv/tipme/app/deploy/staging.env.example /srv/tipme/staging.env
chmod 600 /srv/tipme/staging.env
```

Fill in `/srv/tipme/staging.env`:

- **Hosts:** the real host names.
- **Secrets**, using exactly these recipes (`deploy.sh` refuses a password that would break the database address):
  - `POSTGRES_PASSWORD`: `openssl rand -hex 32`;
  - `OPS_TOTP_KEY` and `BACKUP_KEY`: `openssl rand -base64 32` (exactly 32 bytes);
  - every other secret: `openssl rand -base64 48`.
- **`BACKUP_KEY`:** save a copy off the server, in your password manager. Without it no backup can be read.
- **`RELEASE_KIND=test`:** this copy runs the full release check.

The image runs as uid 1000 and writes backups into `/srv/tipme/backups`:

```sh
mkdir -p /srv/tipme/backups && sudo chown 1000:1000 /srv/tipme/backups
```

`deploy.sh` checks this before it starts.

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

## 5. First deploy

```sh
cd /srv/tipme/app && deploy/scripts/deploy.sh $(git rev-parse HEAD)
```

**First-run checks:**

- Caddy obtains a certificate (`docker compose ... logs caddy`).
- `https://api.staging.<domain>/health/release` shows your commit.
- `docker stats` stays well under 4 GB. Locally the stack idles at about 310 MB.

## 6. The release check's staff account (once)

```sh
cd /srv/tipme/app
TIPME_VERSION=$(cat /srv/tipme/releases/current) docker compose -f deploy/compose.staging.yml \
  --env-file /srv/tipme/staging.env run --rm -e TIPME_CONFIRM_DATABASE=tipme migrate \
  node packages/database/dist/scripts/grant-owner.js --phone <a number you keep for this> --role release_check
```

Then, on your machine within 30 minutes:

```sh
RELEASE_PREVIEW_PASSWORD=... node scripts/release-enrol.mjs --web https://staging.<domain> \
  --api https://api.staging.<domain> --phone <same number> --code <the enrolment code>
```

Keep the printed secret as `RELEASE_OPS_TOTP_SECRET` (with `RELEASE_OPS_PHONE`, `RELEASE_CHECK_TOKEN` and `RELEASE_PREVIEW_PASSWORD`) in your password manager or CI secrets. Grant yourself the Owner role the same way (without `--role`) to use `/ops`.

## 7. Prove it

```sh
pnpm release:check --web https://staging.<domain> --api https://api.staging.<domain> --full
```

Then run the restore drill ([backup-and-restore](backup-and-restore.md)) and one rollback ([deploy-and-rollback](deploy-and-rollback.md)).
