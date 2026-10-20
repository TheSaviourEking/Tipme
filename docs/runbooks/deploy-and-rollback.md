# Runbook: deploying and rolling back staging

## Deploy a commit

**Normally: GitHub Actions → Deploy staging → Run workflow** (or automatically after the checks pass on `main`, when the repository variable `STAGING_AUTO_DEPLOY` is `true`). The workflow:

1. runs every check on the commit;
2. builds `tipme-app:<version>` once (version = the 12-character commit id);
3. **ships it**: the image streams to the server over SSH (`docker save | gzip | ssh … docker load`), and that version's deploy files go to `/srv/tipme/releases/<version>/`;
4. runs `deploy.sh` on the server:
   1. back up the database;
   2. run migrations (guarded);
   3. switch the API and worker;
   4. wait until `/health/release` reports the new version;
   5. record it (`/srv/tipme/releases/current`, and `/srv/tipme/live` points at its files);
   6. keep only the last 5 versions;
5. runs the release check against staging (full once the release-check staff exists).

**If the new version never becomes healthy, it puts the previous one back automatically and the workflow fails.**

**By hand** (the same steps from your machine):

```sh
docker build -f deploy/Dockerfile -t tipme-app:$(git rev-parse --short=12 HEAD) .
STAGING_SSH=deploy@<server> scripts/ship-staging.sh $(git rev-parse --short=12 HEAD)
```

The web app deploys in Vercel from the same push.

## Roll back

1. **API and worker:** on the server, `/srv/tipme/live/scripts/rollback.sh` returns to the version deployed before the current one, or `rollback.sh <version>` to an earlier one still on the server (the last 5 are kept). No migration runs, nothing is built or downloaded: the image is already there.
2. **Web app:** in Vercel, **Deployments → the previous one → Instant Rollback**.
3. **Prove it:** run the release check (`--expect-version <old sha>`, then `--full`).

## The rule that makes rollback safe

Migrations only ever go forward and must work with the **previous** release's code:

- **Adding** a column, table or index is fine, as long as old code doesn't need to know about it.
- **Renaming, removing, or making a column required** happens in two releases. First add the new shape and write to both; later, once no deployed version reads the old shape, remove it.
- Never edit a migration that has run anywhere.

The rollback drill proves this rule on a real stack: A → B (with a migration) → back to A → full check green. Run it locally before any release that adds a migration:

```sh
pnpm staging:local:up <A tag>
node scripts/staging-local.mjs release-staff <A tag>
node scripts/rollback-drill.mjs <A tag>
```

## If a migration itself fails

The deploy stops before switching, so the old version keeps running. Read the error, fix forward in a new commit, and deploy again. If data was changed wrongly, restore from the backup taken just before ([backup-and-restore](backup-and-restore.md)); it is the newest file in `/srv/tipme/backups`.
