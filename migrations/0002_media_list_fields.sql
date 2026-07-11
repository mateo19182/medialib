-- Personal list metadata for movies, series, anime, and manga imports.

ALTER TABLE media_items ADD COLUMN media_format TEXT;
ALTER TABLE media_items ADD COLUMN list_status TEXT;
ALTER TABLE media_items ADD COLUMN progress_current INTEGER;
ALTER TABLE media_items ADD COLUMN progress_total INTEGER;
ALTER TABLE media_items ADD COLUMN personal_score INTEGER;
ALTER TABLE media_items ADD COLUMN notes TEXT;
ALTER TABLE media_items ADD COLUMN tags TEXT;

CREATE INDEX IF NOT EXISTS idx_media_items_source ON media_items(source, source_id);
CREATE INDEX IF NOT EXISTS idx_media_items_list_status ON media_items(kind, list_status);
