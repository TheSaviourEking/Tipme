# Runbook: backups and the restore drill

## What runs on its own

- **Daily backups:** the `backup` container takes one each day, plus one before every deploy's migration.
- **Files** (both mode 600; the newest 14 are kept):
  - `/srv/tipme/backups/tipme-<UTC time>-<version>.dump.enc`;
  - a `.manifest.json` with row counts, ledger totals and the latest migration, read from the same database snapshot as the dump.
- **Encryption:** AES-256-GCM with `BACKUP_KEY`. Keep a copy of that key off the server; without it backups cannot be read.
- **Point-in-time recovery (PR-011), staging only:**
  - Postgres archives its write-ahead log (WAL) to the `walarchive` volume at least every 30 minutes (`archive_timeout=1800`, setting `PG_ARCHIVE_TIMEOUT`). Idle or not, that is a 16 MB segment each time: about 0.8 GB a day. It was every 5 minutes (4.6 GB a day) until 31 October; staging is a test copy, so the owner chose a lighter setting.
  - A physical base backup (`tipme-base-<time>-<version>.tar.enc`) is taken daily, labelled with its own file name, so the `.backup` marker Postgres archives names the file it belongs to.
  - Together they restore the database to any moment the kept backups cover. At most about 30 minutes of data can be lost on staging. The PRD target of ≤ 15 minutes applies to production, which is on Aiven.
  - A base backup is written as `.partial` and renamed only when complete.
  - Production's database is on Aiven, which provides its backups and point-in-time recovery. None of this runs against it.
- **Retention (31 Oct 2026):** the `retention` service decides what can be deleted. `archive_command` only copies. See [Backup retention](#backup-retention).
- **Health:** `GET /health/backups` reports the age of the last logical and base backups, the WAL archiver's state, and the last retention run (mode, outcome, why pruning is blocked as codes, archive size, free disk). It shows times, counts and codes only. The `staging-watch` workflow checks it every 15 minutes and alerts when:
  - retention hasn't run for 3 hours;
  - the disk is under 20% free;
  - the WAL has a gap;
  - there's no verified base backup;
  - pruning is switched on but paused for lack of a recovery drill;
  - no WAL has been archived for 45 minutes.
- **Optional off-server copy:** set `BACKUP_RCLONE_REMOTE` and the `RCLONE_CONFIG_*` settings, then start `--profile offsite`. Every 15 minutes it copies the backups to `<remote>/backups` and the WAL archive to `<remote>/wal`, separately (a failure in one never stops the other), skipping files still being written and never overwriting. When restoring from the bucket, fetch both folders: `<remote>/backups` for the dump or base backup and `<remote>/wal` for point-in-time recovery.

## Backup retention

The `retention` service (`deploy/retention-loop.sh`, hourly) runs `backup-retention.js`. Each run:

1. **Takes a lock**, so two runs never overlap. A lock over an hour old is taken over.
2. **Checks every base backup:**
   - it is in the backup record (`backup_runs`);
   - it decrypts with a valid tag (streamed; nothing is written);
   - it matches its marker, by label for new backups, by start time for those taken before 31 October.

   A marker alone never counts as a backup.

3. **Keeps the backups the policy covers.**
   - Staging keeps `RETENTION_KEEP_DAYS=1`: every verified backup from the last day, plus the newest one from before it, so the whole day is restorable.
   - Never fewer than `RETENTION_MIN_KEEP=1`, and never the only verified backup.
   - Without a window, the newest 7, as before.
4. **Sets the recovery boundary**: the oldest kept backup's first WAL segment.
5. **Checks the WAL is unbroken** from the boundary to the newest archived segment, following timeline switches through the `.history` files.
6. **Lists the candidates**, with each one's size and reason: WAL and markers before the boundary, base backups older than the oldest kept one, and interrupted `.partial` base backups. `.history` and `.tmp` files never qualify.
7. **Blocks deletion** if any of these holds:
   - a base backup is running;
   - there is no verified backup;
   - the WAL has a gap;
   - the newest archived segment is missing;
   - there was no passing recovery drill in `RETENTION_DRILL_MAX_AGE_DAYS=30`.
8. **Deletes only with `RETENTION_MODE=apply`** and nothing blocking it, oldest first. The default is `dry-run`, which deletes nothing.
9. **Records the run** in `backup_retention_runs` and prints the report.

Read the latest report:

```sh
/srv/tipme/live/scripts/compose.sh logs --no-log-prefix --tail 400 retention
# or run one now:
/srv/tipme/live/scripts/compose.sh run --rm retention node packages/database/dist/scripts/backup-retention.js
```

**While in dry-run**, two settings keep the old behaviour so the disk can't fill:

- Postgres runs with `WAL_LEGACY_PRUNE=on`: the old marker-count rule, about 8 days of WAL.
- The backup run keeps the newest 7 base backups (`BASE_BACKUP_RETAIN=7`).

**Switching retention to apply** (do all of these, in order):

1. A dry-run report shows no `BLOCKED` line other than the drill. Its candidates are only WAL and markers before the boundary, and base backups outside the window.
2. Run the PITR drill. It records a pass in `recovery_drills`.
3. Confirm an off-server copy of the backups and WAL exists, if one is configured.
4. In `/srv/tipme/staging.env`, set `RETENTION_MODE=apply`, `WAL_LEGACY_PRUNE=off` and `BASE_BACKUP_RETAIN=0`. Then redeploy.
5. Watch the next run's report, and check `/health/backups` shows `outcome: applied` and more disk free.

**Undoing it:** set `RETENTION_MODE=dry-run`, `WAL_LEGACY_PRUNE=on` and `BASE_BACKUP_RETAIN=7`, and redeploy. Deleted files don't come back, but the coordinator never deletes anything the kept backups need.

## Take a backup now

```sh
/srv/tipme/live/scripts/compose.sh run --rm backup sh deploy/backup-loop.sh once
```

## The restore drill (monthly, and before release day)

```sh
/srv/tipme/live/scripts/compose.sh run --rm restore node packages/database/dist/scripts/restore-drill.js
```

**What it does:**

1. Checks the newest backup against its manifest checksum.
2. Decrypts it. A wrong key fails here.
3. Restores it into the scratch database `tipme_restore_drill` (never the live one).
4. Checks the restored data:
   - every table's row count matches the manifest;
   - ledger totals match;
   - the latest migration matches;
   - every ledger transaction balances.

It prints `Restore drill PASSED` or the list of problems, then drops the scratch database. Set `BACKUP_FILE=/backups/<file>` to drill a specific backup.

## The point-in-time recovery drill (monthly, and before release day)

```sh
/srv/tipme/live/scripts/pitr-drill.sh
```

It takes a base backup, writes a marker row **after** it, forces that WAL into the archive, then restores base backup + archived WAL into a throwaway Postgres container. It prints `PITR drill PASSED` only if the marker came back and every ledger transaction balances, then removes the container and its volume. The live database only gains the marker row. Each run is recorded in `recovery_drills`, pass or fail. Retention prunes only after a pass in the last 30 days.

**A drill to a moment** (monthly, alternating with the one above): run the steps in [Restoring to a moment](#restoring-to-a-moment-point-in-time) up to step 3, on a scratch container only, with the WAL archive mounted **read-only** and archiving **off**. Choose a target time inside the retention window, before a row you just wrote. The drill passes when the restored server stops at that time: rows written before it are there, and the row written after it is not.

## Restoring for real (data loss or a bad migration)

This replaces the live database. Do it only during an incident, after the drill passes on the chosen backup.

1. **Stop everything that writes:** `/srv/tipme/live/scripts/compose.sh stop api worker backup`.
2. **Choose the backup** (`ls /srv/tipme/backups`), usually the one taken just before the bad deploy. Run the drill on it: `BACKUP_FILE=/backups/<file>` with the drill command above. Only restore a backup that passes.
3. **Restore it:**

   ```sh
   /srv/tipme/live/scripts/compose.sh run --rm -e BACKUP_FILE=/backups/<file> \
     -e RESTORE_CONFIRM_DATABASE=tipme restore node packages/database/dist/scripts/restore.js
   ```

   The tool:
   - checks and decrypts the file;
   - **drops and recreates** the `tipme` database, so nothing a later or bad migration added survives;
   - restores the backup;
   - proves the result against the backup's manifest.

   It prints `Restore DONE and proved` or the list of problems.
   The one-shot `restore` service uses the database admin role because it must create or replace databases. Never start it as a long-running service.

4. **Restore least-privilege grants:** while the matching compose release is running, run `/srv/tipme/live/scripts/compose.sh exec -T postgres sh /opt/tipme/bootstrap-roles.sh`. This transfers restored application objects to the migration role and reapplies the runtime/backup grants.
5. **Put back a matching version:** roll back the API and worker (`/srv/tipme/live/scripts/rollback.sh <version>`) to the version that backup came from (its name is in the file name), since a newer version may expect a newer schema. If that version is no longer on the server, ship it again with the workflow. Then start `api worker backup`.
6. **Check:** run the release check (read-only, then `--full`).
7. **Money records:** the restored ledger is the source of truth up to the backup's time. Record the incident window: tips and payouts after it must be reconciled with the provider before anyone is paid.

## Restoring to a moment (point in time)

When the newest logical backup is too old (data written since then matters), restore the newest base backup plus WAL up to just before the incident. This is a manual, rehearsed procedure; run the PITR drill first so you know the base backup and archive work.

1. Stop `api worker backup` as above, and note the incident time in UTC.
2. Decrypt the newest base backup taken **before** that time into a new volume (as the drill does: `node packages/database/dist/scripts/decrypt-backup.js /backups/<base file> /out/base.tar`).
3. Start a scratch Postgres from it as the drill does, with two differences:
   - add `recovery_target_time = '<UTC time>'` to `postgresql.auto.conf`;
   - mount the WAL archive **read-write** and start it with archiving **on** (`-c archive_mode=on -c archive_command='/bin/sh /etc/postgresql/archive-wal.sh %p %f'`, with `deploy/postgres/archive-wal.sh` mounted there), so the new timeline's history file and its first segments reach the archive.

   Check the data there.

4. Only when it is right: stop `postgres`, move its data volume aside (do not delete it), copy the recovered data directory in, and start `postgres`, then the matching API version (step 4 above).
5. **Take a fresh base backup at once** (`compose.sh run --rm backup node packages/database/dist/scripts/base-backup.js`, without `--if-missing-today`). Older base backups are only good up to the incident time from now on: the archive still holds the bad WAL written after it.
6. Check that the archive has the new `0000000N.history` file (`ls /srv/tipme/wal` via the backup container) and that `/health/backups` shows WAL archived in the last few minutes.
7. Run the release check and reconcile money after the recovery point, as in step 6 above.
