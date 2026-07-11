-- Media titles are not globally unique. Keep source/source_id as the stable
-- external identity and allow duplicate display titles within a kind.

PRAGMA foreign_keys = off;

CREATE TABLE media_items_new (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     normalized_title TEXT NOT NULL,
     source TEXT,
     source_id TEXT,
     source_url TEXT,
     year INTEGER,
     cover_key TEXT,
     cover_url TEXT,
     description TEXT,
     rating INTEGER,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     enriched_at TEXT,
     media_format TEXT,
     list_status TEXT,
     progress_current INTEGER,
     progress_total INTEGER,
     personal_score INTEGER,
     notes TEXT,
     tags TEXT
   );

INSERT INTO media_items_new (
  id, kind, title, normalized_title, source, source_id, source_url, year,
  cover_key, cover_url, description, rating, created_at, enriched_at,
  media_format, list_status, progress_current, progress_total, personal_score,
  notes, tags
)
SELECT
  id, kind, title, normalized_title, source, source_id, source_url, year,
  cover_key, cover_url, description, rating, created_at, enriched_at,
  media_format, list_status, progress_current, progress_total, personal_score,
  notes, tags
FROM media_items;

DROP TABLE media_items;
ALTER TABLE media_items_new RENAME TO media_items;

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_items_source ON media_items(source, source_id)
  WHERE source IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_items_kind ON media_items(kind);
CREATE INDEX IF NOT EXISTS idx_media_items_title ON media_items(normalized_title);
CREATE INDEX IF NOT EXISTS idx_media_items_list_status ON media_items(kind, list_status);

PRAGMA foreign_keys = on;
