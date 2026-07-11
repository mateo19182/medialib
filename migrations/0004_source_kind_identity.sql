-- Some sources namespace IDs by media type. MyAnimeList anime/1 and manga/1
-- are different entities, so include kind/source_kind in unique identities.

DROP INDEX IF EXISTS idx_media_items_source;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_items_source_kind_id ON media_items(source, kind, source_id)
  WHERE source IS NOT NULL AND source_id IS NOT NULL;

CREATE TABLE links_new (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     url TEXT NOT NULL,
     source TEXT NOT NULL,
     source_kind TEXT,
     source_id TEXT,
     entity_type TEXT,
     entity_id INTEGER,
     title TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     raw_json TEXT,
     saved_at TEXT NOT NULL DEFAULT (datetime('now')),
     saved_via TEXT NOT NULL DEFAULT 'web'
   );

INSERT INTO links_new (
  id, url, source, source_kind, source_id, entity_type, entity_id, title,
  status, raw_json, saved_at, saved_via
)
SELECT
  id, url, source, source_kind, source_id, entity_type, entity_id, title,
  status, raw_json, saved_at, saved_via
FROM links;

DROP TABLE links;
ALTER TABLE links_new RENAME TO links;

CREATE UNIQUE INDEX IF NOT EXISTS idx_links_source_kind_id ON links(source, source_kind, source_id)
  WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_links_saved_at ON links(saved_at);
CREATE INDEX IF NOT EXISTS idx_links_status ON links(status);
