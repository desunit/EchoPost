-- Historical backfill of older X posts (batch sync going backwards in time).
-- Forward sync tracks the newest imported id in last_imported_x_post_id;
-- backfill walks the other direction and remembers how far back it has reached
-- so each batch only fetches still-older posts that don't exist yet.
ALTER TABLE x_account ADD COLUMN backfill_oldest_x_post_id TEXT;
ALTER TABLE x_account ADD COLUMN backfill_oldest_at TEXT;
ALTER TABLE x_account ADD COLUMN backfill_complete INTEGER NOT NULL DEFAULT 0;
