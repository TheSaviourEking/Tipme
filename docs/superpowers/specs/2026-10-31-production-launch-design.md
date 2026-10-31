# Production launch: TipMe live on usetipme.xyz, with real tips

Status: APPROVED by the owner, 31 October 2026 ("Sure, let's proceed", accepting the recommendations below).
Builds on: `2026-10-31-live-pilot-design.md` (Bachs live mode, payouts, bank setup, reversals, reserve, activation). That design still holds for payments; this one adds the production infrastructure and replaces its §6.6.
Related: `docs/runbooks/remote-database.md` (#63), `docs/runbooks/photos.md` (#64), ADR-0004, ADR-0011, ADR-0013, `docs/00-DECISIONS.md`.

## 1. Intent

The owner's words (31 Oct 2026):

- "We're moving the current staging to main and deploying that with real Bachs, ZeptoMail and an entire infra."
- "We should optimise for prod: maybe multiple instances of the API, or clustered."
- "We start with this one machine with no downtime, then we'd add more machines if need be."
- "We should set up all we need for prod to go live properly. It'd go live with tipping on."

So production goes live complete, from `main`, on the existing server. It runs several copies of the API, deploys without downtime, and has real Bachs tips and payouts and real email. It's built so that a second machine can be added later without redesign.

## 1a. Scope and order (builder's call)

This design and the live-pilot design are planned as **two plans**:

1. production infrastructure (this document);
2. live payments (Bachs live mode, payouts, the "Get paid" card, the reserve job, the reversal pause and, if §9 Q7 chooses it, the pilot notice).

Both must ship before launch day (§6.11). The payments plan is built and tested on staging (sandbox) first. Its live settings are proven during step 2 of launch day.

## 2. Goals

1. **Production runs from `main`** at `https://usetipme.xyz` (web, Vercel) and `https://api.usetipme.xyz` (API).
2. **Several API copies** on this server behind a health-checked load balancer, plus two worker copies. Losing one copy loses no requests.
3. **Deploys and rollbacks without downtime.** Requests in flight finish, and new ones go only to healthy copies.
4. **Real money:** Bachs live tips, payouts in TipMe's screens, TipMe paying all fees, and the reserve alert. All of it comes from the live-pilot design, as approved there.
5. **Real email:** ZeptoMail from `usetipme.xyz`, with bounce and complaint webhooks.
6. **Production data on Aiven,** reached only over TLS with checked certificates, using the runtime, migrator and admin roles (#63).
7. **Photos in a private R2 bucket** for production (#64).
8. **Observability from day one:** Sentry errors, a production watcher with Slack alerts, uptime checks, and the admin Overview.
9. **Staging keeps working** on the same machine, and a staging deploy never affects production.

## 3. Non-goals

- More than one machine. That's left as a documented path (§6.10).
- Kubernetes, Swarm, or any orchestrator. Docker Compose stays.
- Automatic refunds in the ledger (Phase 3), and cash rewards with real money.
- Moving staging to a managed database. It stays on the server (owner, 31 Oct); that move is on the TODO list.
- Phone sign-in.

## 4. Anti-goals

These would count as failures even if the system "works":

- **A deploy drops requests**, or serves a mix of versions that disagree about the schema.
- **A staging deploy, restart or fault reaches production** (or the reverse), through a shared Caddy, network, Redis, env file or secret.
- **Production starts with pretend payments, the sandbox, mock mail, a preview password, or staging's secrets.**
- **Real money moves before the activation steps are done** (live-pilot design §6.8).
- **A recipient is paid twice, or paid money that isn't theirs** (live-pilot design §4).
- **Production data on a connection without a checked certificate.**

## 5. Constraints

- **Migrations are additive and backward-compatible** (AGENTS.md rule): during a rolling deploy, the old and new versions run against the same schema.
- **One public entry.** Only one process can hold ports 80 and 443 on the machine.
- **Machine:** 4 vCPU, 7.7 GB RAM, 48 GB disk, shared with staging. Staging uses about 1.3 GB RAM today. Disk is about 38 GB free once the old WAL archive is deleted, which the owner does.
- **Automatic deploys run the workflow from `main`**, and workflow files must match on `dev` and `main` (two incidents on 31 Oct).
- **Merges are the owner's.** Production deploys are approved by the owner.

## 6. Design

### 6.1 Three Docker Compose projects on one machine

| Project                                     | Contains                                            | Public       |
| ------------------------------------------- | --------------------------------------------------- | ------------ |
| `tipme-edge` (new)                          | Caddy only                                          | ports 80/443 |
| `tipme-staging` (existing, minus its Caddy) | API, worker, Postgres, Redis, backup                | none         |
| `tipme-production` (new)                    | API ×3, worker ×2, Redis, tools (migrate, db-roles) | none         |

- **Networks:** two external Docker networks, `edge-staging` and `edge-production`. The edge Caddy joins both; each project's API joins only its own. Each project keeps its own `internal` network for Redis (and Postgres on staging). Production's API also joins an egress network for Aiven, Bachs, ZeptoMail, R2 and Sentry, as staging's worker does.
- **Separation:** no volume, network, env file or secret is shared between staging and production.
- **Staging's Caddy moves to the edge project once**, in a planned step with a minute's notice. After that, redeploying either project never restarts Caddy.
- **Who deploys the edge (builder's call):**
  - The edge has its own files (`deploy/edge/`: Caddyfile and compose).
  - Only the `deploy-production` workflow ships them, from `main`, with the owner's approval. A staging deploy never touches the edge.
  - A Caddyfile change therefore reaches both hosts only through `main`, and its CI configuration test checks both sites.

### 6.2 The edge Caddy

- **One `Caddyfile`, with one site per host:**
  - `api.staging.usetipme.xyz` goes to staging's API, as today.
  - `api.usetipme.xyz` goes to production's API copies. The upstreams are found by DNS on `edge-production`: Caddy's dynamic `a` upstreams, refreshed every few seconds, so new copies join on their own.
- **Load balancing:** round-robin.
- **Active health checks** on `GET /health/ready` every 2 seconds. An unhealthy copy gets no traffic.
- **Retries:** `lb_try_duration` of about 5 seconds, so a request reaching a copy that's shutting down goes to another.
- **TLS:** certificates from Let's Encrypt, as today. Security headers as staging has them, but no preview password on production.

### 6.3 Production API: three copies

- **Three containers of the same image,** each about 384 MB and one Node process. Node uses one CPU per process, so three copies use the machine's CPUs while leaving room for staging and the workers.
- **The copies are stateless:**
  - sessions live in the database;
  - rate limits and queues in Redis;
  - the 30-second health cache is per copy, which is harmless.

  The builder confirms nothing else is held in memory per process.

- **Graceful shutdown:** on stop, a copy first fails its readiness check, so Caddy stops sending it traffic. It then finishes in-flight requests (up to about 10 seconds) and exits.
- **`TRUST_PROXY_HOPS=1`**, so each supporter's own address is used for rate limits.

### 6.4 Production worker: two copies

- **They're safe to run in parallel:** both background loops claim their work with `SKIP LOCKED`, and scheduled jobs go through the BullMQ queue, where one tick is processed once. One copy can be lost without losing work.
- **Graceful shutdown** is unchanged: in-flight jobs finish, within a limit.

### 6.5 Deploys with no downtime

- **Two copies of the API service** per version, `api-blue` and `api-green`. Both carry the network alias `prod-api` on `edge-production`.
- **The `deploy-production` script:**
  1. Check the image and the files have been shipped.
  2. Run `db-roles.js`, then migrations as the migrator, then `db-roles.js` again.
  3. Start the idle colour on the new version, ×3.
  4. Wait until all three are ready.
  5. Caddy picks them up through DNS and health checks.
  6. Stop the old colour gracefully.
  7. Replace the workers one at a time.
  8. Record the version, as staging does.
- **Rollback** is the same switch back to the previous version's colour, and the previous image is kept. It's only safe when the migrations in between were backward-compatible, which the migration rule already requires. A failed health wait leaves the old colour serving and stops.
- **Redis** isn't restarted by a deploy.

### 6.6 Shipping a version

- **"Staging ran it" is matched on the file tree, not the commit id** (builder's call). `main` receives `dev` through merge commits, so its ids are new, but their file tree is the code staging tested.
  - When staging's full release check passes, the deploy workflow records a commit status, `release/staging-full`, with `tree <sha>`, on the version it deployed. This mirrors CI's `ci/tested-tree`.
  - `deploy-production` refuses a `main` commit whose tree has no such pass, unless the owner overrides with a written reason.
  - A staging run that fell back to the read-only check records nothing.
  - The image is built for the `main` commit. Same tree, same image contents.
- **`deploy-production` workflow:**
  - run by hand from `main` (`workflow_dispatch`), in a GitHub `production` environment that requires the owner's approval;
  - ships the image and the production files over SSH (deploy user), and runs the script;
  - then runs the read-only release check against production.
- **Never automatic.** A merge to `main` doesn't deploy production. _Builder's call; the owner may choose an automatic deploy after staging passes._

### 6.7 Configuration and secrets

- **`/srv/tipme/production.env`,** mode 600 and owned by deploy, with every secret generated fresh. Nothing is copied from staging.
- **`deploy/production.env.example`** lists every setting.
- **The API and worker config rules refuse** anything unsafe for production: mock or sandbox providers, a preview password, a database without a checked certificate, and payments live without a live provider. Most of these exist already; this design adds the rest.

| Area             | Settings                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy             | `DEPLOYMENT_MODE=production`, `NODE_ENV=production`, `RELEASE_KIND=live`                                                                                   |
| Database (Aiven) | `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DATABASE_ADMIN_URL` (roles only), the three role passwords, the CA at `/run/secrets/db-ca.pem`                  |
| Payments         | `PAYMENT_PROVIDER=bachs-live`, `BACHS_LIVE_API_KEY` (`sk_live_`), `BACHS_LIVE_WEBHOOK_SECRET`, `PAYMENTS_LIVE_ENABLED`, `BACHS_RESERVE_ALERT_MINOR=100000` |

**Before activation (builder's call, amends live-pilot design §6.1):** production may run `bachs-live` with `PAYMENTS_LIVE_ENABLED=false`.

- Checkout is closed: new tips are refused with "Tipping opens soon".
- Bachs webhooks are verified and recorded, so step 4 of launch day can prove the live webhook.
- `/health/release` reports `paymentProvider: bachs-live` and `paymentsLive: false`.
- Mock and sandbox stay refused in production.
  | Mail | `MAIL_DEFAULT_PROVIDER=zeptomail`, the ZeptoMail key, API base and webhook key (a production Mail Agent), `MAIL_FROM_DOMAIN=usetipme.xyz` (the domain verified in ZeptoMail, owner 31 Oct; `mail.usetipme.xyz` is only SES's MAIL FROM and isn't used for ZeptoMail), `MAIL_FROM_NAME=TipMe`, `MAIL_REPLY_TO=support@usetipme.xyz`. The root `_dmarc` record must be fixed to one record before launch. |
  | Photos | the four `R2_*` settings, for a separate production bucket |
  | Web | `WEB_ORIGIN=https://usetipme.xyz`, `API_ORIGIN=https://api.usetipme.xyz`, `WEB_REVALIDATE_SECRET` (shared with Vercel production) |
  | Secrets | `STATUS_TOKEN_SECRET`, `AUTH_CODE_SECRET`, `OPS_TOTP_KEY`, `MAIL_SEAL_KEY`: fresh |
  | Observability | `SENTRY_DSN` and `SENTRY_ENVIRONMENT=production` |
  | Off for now | analytics (D-07) |

### 6.8 Web (Vercel production)

- **Production environment variables:**
  - `NEXT_PUBLIC_API_ORIGIN=https://api.usetipme.xyz`, `API_INTERNAL_ORIGIN=https://api.usetipme.xyz`;
  - `WEB_REVALIDATE_SECRET` (the same as the API's);
  - the Sentry DSN for the web.
- **`usetipme.xyz`** already points at Vercel. Production replaces the countdown page once launch is switched on.
- **Search indexing** as §9 decides.

### 6.9 Observability and alerts

- **Sentry:** a production environment for the API, worker and web.
- **A production watcher** (`watch-production` workflow, every 5 minutes):
  - readiness;
  - the web;
  - `paymentsLive` matching the activation state;
  - the reserve balance;
  - the webhook endpoint answering 401 unsigned.

  It posts to Slack through `ALERT_WEBHOOK_URL`, a new production secret.

- **Production backups:** Aiven's, by plan (§9 Q8). These replace the live-pilot design §6.8's off-site copy and restore-drill gates (builder's call):
  - Before activation, the owner restores Aiven's latest backup once into a temporary fork. Check that it opens and that its row counts match, then delete the fork. That's a one-off drill, recorded in the runbook.
  - The migration script's backup step (`MIGRATE_BACKUP_DONE`) is set by the deploy because Aiven backs up continuously. On Aiven's Startup plan, point-in-time restore covers 2 days.
- **Uptime:** the watcher, plus an external ping on `/health/live`. The service is the builder's choice; it needs no secrets.

### 6.10 Adding machines later (documented, not built)

The same `tipme-production` project runs on a second machine, behind a load balancer: Cloudflare Load Balancing, or a cloud load balancer. The database is already shared (Aiven). Redis moves to a managed instance, so rate limits and queues are shared. Photos are already in R2. Sessions are in the database. The design avoids anything that would block this, such as files on local disk or in-memory state.

### 6.11 Launch day: production opens with payments on

The owner, 31 Oct: "We're launching prod with payments on." Nobody outside sees production without payments: `usetipme.xyz` keeps serving the countdown page until step 6.

1. **Owner prerequisites:**
   - §9's answers;
   - the Aiven database, its roles and the CA;
   - ZeptoMail's production agent and webhook;
   - the R2 bucket;
   - the Bachs live key and webhook;
   - the Vercel variables;
   - the Sentry DSN;
   - a funded reserve.
2. **A setup deploy, not public,** with `PAYMENTS_LIVE_ENABLED=false`: the read-only check, and the owner's enrolment in the admin area.
3. **Make ZeptoMail active** in Ops → Providers: send a test, open its link, switch.
4. **Verify the Bachs live webhook** with a real delivery.
5. **Switch payments on:** set `PAYMENTS_LIVE_ENABLED=true` and deploy. Smoke test by tipping ₦1,000 to the owner's page, confirming it, and withdrawing it.
6. **Open the site:** `usetipme.xyz` switches from the countdown to TipMe, as §9 decides (public, or the pilot first).

## 7. Testing

- **Config tests:** every production refusal in §6.7.
- **Edge Caddy configuration test,** in a container in CI: both hosts route, an unhealthy upstream gets no traffic, and a retry happens during a stop.
- **Deploy-script tests,** with a fake Docker as staging's tests have:
  - blue/green order;
  - roles and migrations before the switch;
  - an unhealthy new colour leaves the old one serving;
  - rollback;
  - the refusal when staging hasn't passed.
- **A local rehearsal:** the production project, the edge and both colours on the local Docker. A load test runs during a deploy, and **no request fails**. That's the evidence for "no downtime".
- **Payments:** as in the live-pilot design §7.

## 8. Decisions this records

- **Production:** from `main`, on this machine, three API copies and two workers, blue/green deploys, one edge Caddy, the database on Aiven, email from ZeptoMail on `usetipme.xyz`, photos in a production R2 bucket.
- **Staging** stays on the server's Postgres, behind the shared edge.
- **Launch is complete:** tipping is on at launch, after the activation steps.

## 9. Owner decisions (31 October 2026)

**Answered from Bachs's docs:**

- **Q2, payout fees:** Bachs charges a payout's fee on top of the amount, to the account paid out (₦50 flat for NGN bank payouts, per its fee page). TipMe covers it:
  - before each payout, TipMe moves the fee from its own balance to the recipient's account (`POST /v1/transfers`: instant, irreversible, no fee listed, idempotency key `payout-fee.<payoutId>`);
  - then it pays out the full amount the recipient asked for;
  - the fee is booked as a TipMe cost.
  - **To confirm with Bachs:** NGN transfers, and any account-specific fee. The payout's reported `fee` decides the top-up.
- **Q3, can recipients move money themselves?** No:
  - accounts are created and run by TipMe ("does not sign up for Bachs"), with no API key per account;
  - account setup sets every account's NGN payout schedule to `interval: "manual"` (`POST /v1/balance_settings` with `X-Account-Id`);
  - the "money left outside TipMe" safeguard in the live-pilot design §6.2 stays as defence in depth.

**The owner's decisions:**

|     | Decision                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Q4  | Ask Bachs for written confirmation, but launch doesn't wait for it. "Live Connect is active" is recorded as the owner's decision.  |
| Q5  | During launch, the owner alone settles money issues, each one audited. A second approver comes when there's a second staff member. |
| Q6  | The owner funds the live reserve before activation, ₦20,000 to start. The alert fires below ₦1,000.                                |
| Q7  | Not yet decided. The pilot notice and search indexing are settings (`PILOT_NOTICE`, `SITE_INDEXING`), set on launch day.           |
| Q8  | Aiven Business (14 days of point-in-time restore) for real money. Startup is acceptable for the first weeks.                       |
| Q9  | Production deploys by hand only, with the owner's approval.                                                                        |
| Q10 | Production gets its own deploy user and SSH key on the server, separate from staging's.                                            |

## 10. Left to the builder

- The exact Caddy directives and timings, and the health-check interval.
- The colour mechanics (two services, or one service with versioned project names), as long as §6.5's order holds.
- Container memory limits, the uptime service, file layout and the order of work.
- Activation stays last.
