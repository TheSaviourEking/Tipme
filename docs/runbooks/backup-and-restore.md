# Runbook: backups and the restore drill

## What runs on its own

- **Daily backups:** the `backup` container takes one each day, plus one before every deploy's migration.
- **Files** (both mode 600; the newest 14 are kept):
  - `/srv/tipme/backups/tipme-<UTC time>-<version>.dump.enc`;
  - a `.manifest.json` with row counts, ledger totals and the latest migration, read from the same database snapshot as the dump.
- **Encryption:** AES-256-GCM with `BACKUP_KEY`. Keep a copy of that key off the server; without it backups cannot be read.
- **Point-in-time recovery (PR-011):** Postgres archives its write-ahead log (WAL) to the `walarchive` volume at least every 5 minutes (`archive_timeout=300`), and a physical base backup (`tipme-base-<time>-<version>.tar.enc`, the newest 7 kept) is taken daily. Together they can restore the database to any moment since the oldest base backup: at most about 5 minutes of data can be lost (PRD target ≤ 15). Archived WAL is kept back to the start of the 8th-newest base backup (the 7 kept plus one spare), however old that is, and timeline `.history` files are always kept. A base backup is written as `.partial` and renamed only when complete.
- **Health:** `GET /health/backups` reports the age of the last logical and base backups and the WAL archiver's state (times and counts only). The `staging-watch` workflow checks it every 15 minutes.
- **Optional off-server copy:** set `BACKUP_RCLONE_REMOTE` and the `RCLONE_CONFIG_*` settings, then start `--profile offsite`. Every 15 minutes it copies the backups to `<remote>/backups` and the WAL archive to `<remote>/wal`, separately (a failure in one never stops the other), skipping files still being written and never overwriting. When restoring from the bucket, fetch both folders: `<remote>/backups` for the dump or base backup and `<remote>/wal` for point-in-time recovery.

## Take a backup now

```sh
/srv/tipme/live/scripts/compose.sh run --rm backup sh deploy/backup-loop.sh once
```

## The restore drill (monthly, and before release day)

```sh
/srv/tipme/live/scripts/compose.sh run --rm backup node packages/database/dist/scripts/restore-drill.js
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

It takes a base backup, writes a marker row **after** it, forces that WAL into the archive, then restores base backup + archived WAL into a throwaway Postgres container. It prints `PITR drill PASSED` only if the marker came back and every ledger transaction balances, then removes the container and its volume. The live database only gains the marker row.

## Restoring for real (data loss or a bad migration)

This replaces the live database. Do it only during an incident, after the drill passes on the chosen backup.

1. **Stop everything that writes:** `/srv/tipme/live/scripts/compose.sh stop api worker backup`.
2. **Choose the backup** (`ls /srv/tipme/backups`), usually the one taken just before the bad deploy. Run the drill on it: `BACKUP_FILE=/backups/<file>` with the drill command above. Only restore a backup that passes.
3. **Restore it:**

   ```sh
   /srv/tipme/live/scripts/compose.sh run --rm -e BACKUP_FILE=/backups/<file> \
     -e RESTORE_CONFIRM_DATABASE=tipme backup node packages/database/dist/scripts/restore.js
   ```

   The tool:
   - checks and decrypts the file;
   - **drops and recreates** the `tipme` database, so nothing a later or bad migration added survives;
   - restores the backup;
   - proves the result against the backup's manifest.

   It prints `Restore DONE and proved` or the list of problems.

4. **Put back a matching version:** roll back the API and worker (`/srv/tipme/live/scripts/rollback.sh <version>`) to the version that backup came from (its name is in the file name), since a newer version may expect a newer schema. If that version is no longer on the server, ship it again with the workflow. Then start `api worker backup`.
5. **Check:** run the release check (read-only, then `--full`).
6. **Money records:** the restored ledger is the source of truth up to the backup's time. Record the incident window: tips and payouts after it must be reconciled with the provider before anyone is paid.

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
