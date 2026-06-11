# Backup and restore

## What gets backed up

| Asset | How |
| --- | --- |
| SQLite database | `VACUUM INTO` snapshot — safe while the app runs (WAL) |
| Media files | `data/media/` — copy weekly (files are content-addressed, never modified) |
| Environment | keep `.env` in your secrets manager; `.env.example` documents the shape |

## Schedule

- The `backup_database` job runs daily at 04:00 (server time) and keeps the
  14 most recent snapshots in `BACKUP_PATH` (default `./backups`).
- Run manually any time: `npm run backup` (snapshots **and** verifies).
- For off-site copies, rsync `backups/` and `data/media/` to S3-compatible
  storage from cron; encrypt with `age` or `gpg` first if the bucket is shared.

## Restore procedure

```bash
# 1. stop the app
# 2. replace the database with a snapshot
cp backups/echopost-<stamp>.db data/echopost.db
rm -f data/echopost.db-wal data/echopost.db-shm
# 3. restore media if needed
rsync -a media-backup/ data/media/
# 4. start the app — migrations reconcile automatically
```

## Monthly restore test

`npm run backup` already opens the latest snapshot and verifies post,
subscriber, and migration counts. For a fuller test:

```bash
DATABASE_PATH=/tmp/restore-test.db cp backups/<latest>.db /tmp/restore-test.db
DATABASE_PATH=/tmp/restore-test.db PORT=3999 npm start &
curl -sf http://localhost:3999/health/db && curl -sf http://localhost:3999/rss > /dev/null && echo OK
```

Checks: database opens, migrations match, homepage renders, RSS generates.
