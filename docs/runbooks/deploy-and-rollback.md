# Runbook: deploying and rolling back staging

## Deploy a commit

On the server, as `deploy`:

```sh
cd /srv/tipme/app && deploy/scripts/deploy.sh <git sha>
```

The script does, in order:

1. fetch and check out the commit;
2. build `tipme-app:<sha>`;
3. back up the database;
4. run migrations (guarded);
5. switch the API and worker;
6. wait until `https://api.staging.<domain>/health/release` reports the new version;
7. record it in `/srv/tipme/releases/current` (and the list `releases/deployed`).

**If the new version never becomes healthy, it puts the previous one back automatically and exits with an error.**

Then deploy the same commit of the web app in Vercel (pushing to the branch Vercel watches does it), and run the release check from your machine:

```sh
pnpm release:check --web https://staging.<domain> --api https://api.staging.<domain> --expect-version <sha> --full
```

## Roll back

1. **API and worker:** `deploy/scripts/rollback.sh` returns to the previous version, or `rollback.sh <version>` to an earlier one whose image still exists. No migration runs.
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
