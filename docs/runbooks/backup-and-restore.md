# Runbook: backups and the restore drill

## What runs on its own

- **Daily backups:** the `backup` container takes one each day, plus one before every deploy's migration.
- **Files** (both mode 600; the newest 14 are kept):
  - `/srv/tipme/backups/tipme-<UTC time>-<version>.dump.enc`;
  - a `.manifest.json` with row counts, ledger totals and the latest migration, read from the same database snapshot as the dump.
- **Encryption:** AES-256-GCM with `BACKUP_KEY`. Keep a copy of that key off the server; without it backups cannot be read.
- **Optional off-server copy:** set `BACKUP_RCLONE_REMOTE` and the `RCLONE_CONFIG_*` settings, then start `--profile offsite`. It copies new files hourly and never overwrites.

## Take a backup now

```sh
TIPME_VERSION=$(cat /srv/tipme/releases/current) docker compose -f deploy/compose.staging.yml \
  --env-file /srv/tipme/staging.env run --rm backup sh deploy/backup-loop.sh once
```

## The restore drill (monthly, and before release day)

```sh
TIPME_VERSION=$(cat /srv/tipme/releases/current) docker compose -f deploy/compose.staging.yml \
  --env-file /srv/tipme/staging.env run --rm backup node packages/database/dist/scripts/restore-drill.js
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

## Restoring for real (data loss or a bad migration)

This replaces the live database. Do it only during an incident, after the drill passes on the chosen backup.

1. **Stop everything that writes:** `... stop api worker backup`.
2. **Choose the backup** (`ls /srv/tipme/backups`), usually the one taken just before the bad deploy. Run the drill on it: `BACKUP_FILE=/backups/<file>` with the drill command above. Only restore a backup that passes.
3. **Restore it:**

   ```sh
   TIPME_VERSION=<the version that backup came from> docker compose -f deploy/compose.staging.yml \
     --env-file /srv/tipme/staging.env run --rm -e BACKUP_FILE=/backups/<file> \
     -e RESTORE_CONFIRM_DATABASE=tipme backup node packages/database/dist/scripts/restore.js
   ```

   The tool:
   - checks and decrypts the file;
   - **drops and recreates** the `tipme` database, so nothing a later or bad migration added survives;
   - restores the backup;
   - proves the result against the backup's manifest.

   It prints `Restore DONE and proved` or the list of problems.

4. **Put back a matching version:** deploy or roll back the API and worker to the version that backup came from (its name is in the file name), since a newer version may expect a newer schema. Then start `api worker backup`.
5. **Check:** run the release check (read-only, then `--full`).
6. **Money records:** the restored ledger is the source of truth up to the backup's time. Record the incident window: tips and payouts after it must be reconciled with the provider before anyone is paid.
