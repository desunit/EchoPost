-- WordPress import idempotency. Mirrors the x_post_id pattern: a unique
-- external id so re-running the importer skips posts already brought over.
-- Partial index keeps the uniqueness constraint off the many NULL (non-WP) rows.
ALTER TABLE posts ADD COLUMN wp_post_id INTEGER;
CREATE UNIQUE INDEX idx_posts_wp_post_id ON posts(wp_post_id) WHERE wp_post_id IS NOT NULL;
