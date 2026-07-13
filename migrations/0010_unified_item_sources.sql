-- One catalog discriminator (`item_kind`) and one origin axis (`provider`).
-- Saved links and provider-owned identifiers now share the same source record.

CREATE TABLE item_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_kind TEXT,
  item_id INTEGER,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  url TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  raw_json TEXT,
  saved_at TEXT,
  saved_via TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_item_sources_provider_item_id
  ON item_sources(provider, item_kind, provider_id)
  WHERE item_kind IS NOT NULL;
CREATE UNIQUE INDEX idx_item_sources_unbound_provider_id
  ON item_sources(provider, provider_id)
  WHERE item_kind IS NULL;
CREATE UNIQUE INDEX idx_item_sources_item_provider
  ON item_sources(item_kind, item_id, provider)
  WHERE item_kind IS NOT NULL AND item_id IS NOT NULL;
CREATE UNIQUE INDEX idx_item_sources_primary_item
  ON item_sources(item_kind, item_id)
  WHERE item_kind IS NOT NULL AND item_id IS NOT NULL AND is_primary = 1;
CREATE INDEX idx_item_sources_item ON item_sources(item_kind, item_id);
CREATE INDEX idx_item_sources_saved_at ON item_sources(saved_at DESC);
CREATE INDEX idx_item_sources_status ON item_sources(status) WHERE saved_at IS NOT NULL;

-- Provider names such as `myanimelist:anime` encoded the old entity type.
-- Strip that suffix now that item_kind carries the namespace explicitly.
INSERT OR IGNORE INTO item_sources (
  item_kind, item_id, provider, provider_id, url, status, is_primary, created_at
)
SELECT
  entity_type,
  entity_id,
  CASE
    WHEN provider LIKE '%:' || entity_type
      THEN substr(provider, 1, length(provider) - length(entity_type) - 1)
    ELSE provider
  END,
  external_id,
  external_url,
  'ok',
  is_primary,
  created_at
FROM external_ids;

-- Preserve media source identities even if an old row had no corresponding
-- saved link or external_ids record.
INSERT OR IGNORE INTO item_sources (
  item_kind, item_id, provider, provider_id, url, status
)
SELECT kind, id, source, source_id, source_url, 'ok'
FROM media_items
WHERE source IS NOT NULL AND source_id IS NOT NULL AND source_id <> '';

-- A provider resource that does not resolve to a catalog item (currently a
-- playlist) intentionally has a NULL item_kind. YouTube videos resolve to tracks.
INSERT OR IGNORE INTO item_sources (
  item_kind, item_id, provider, provider_id, url, title, status,
  raw_json, saved_at, saved_via
)
SELECT
  CASE
    WHEN entity_type IN ('author', 'artist', 'album', 'track', 'book', 'movie', 'series', 'anime', 'manga', 'webtoon', 'comic')
      THEN entity_type
    WHEN source_kind IN ('artist', 'album', 'track', 'book', 'movie', 'series', 'anime', 'manga', 'webtoon', 'comic')
      THEN source_kind
    WHEN source = 'youtube' AND source_kind = 'video' THEN 'track'
    ELSE NULL
  END,
  entity_id,
  source,
  COALESCE(NULLIF(source_id, ''), url),
  url,
  title,
  status,
  raw_json,
  saved_at,
  saved_via
FROM links;

-- If a saved link matched an identifier inserted above, add its saved-link
-- fields to that existing source record instead of creating a duplicate.
UPDATE item_sources AS target
SET
  item_id = COALESCE(target.item_id, source.entity_id),
  url = COALESCE(source.url, target.url),
  title = COALESCE(source.title, target.title),
  status = source.status,
  raw_json = COALESCE(source.raw_json, target.raw_json),
  saved_at = source.saved_at,
  saved_via = source.saved_via
FROM links AS source
WHERE target.provider = source.source
  AND target.provider_id = COALESCE(NULLIF(source.source_id, ''), source.url)
  AND target.item_kind IS CASE
    WHEN source.entity_type IN ('author', 'artist', 'album', 'track', 'book', 'movie', 'series', 'anime', 'manga', 'webtoon', 'comic')
      THEN source.entity_type
    WHEN source.source_kind IN ('artist', 'album', 'track', 'book', 'movie', 'series', 'anime', 'manga', 'webtoon', 'comic')
      THEN source.source_kind
    WHEN source.source = 'youtube' AND source.source_kind = 'video' THEN 'track'
    ELSE NULL
  END;

-- Enrichment queues now use the same concrete ItemKind values. The old
-- generic `media` marker is replaced by the media item's actual kind.
CREATE TABLE enrich_queue_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_kind TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_kind, item_id)
);

INSERT OR IGNORE INTO enrich_queue_new (id, item_kind, item_id, attempts, created_at)
SELECT
  queue.id,
  CASE
    WHEN queue.entity_type = 'media'
      THEN (SELECT kind FROM media_items WHERE id = queue.entity_id)
    ELSE queue.entity_type
  END,
  queue.entity_id,
  queue.attempts,
  queue.created_at
FROM enrich_queue AS queue
WHERE queue.entity_type <> 'media'
   OR EXISTS (SELECT 1 FROM media_items WHERE id = queue.entity_id);

DROP TABLE enrich_queue;
ALTER TABLE enrich_queue_new RENAME TO enrich_queue;

-- Source identity belongs in item_sources, not on visual-media rows.
CREATE TABLE media_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
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
  id, kind, title, normalized_title, year, cover_key, cover_url, description,
  rating, created_at, enriched_at, media_format, list_status,
  progress_current, progress_total, personal_score, notes, tags
)
SELECT
  id, kind, title, normalized_title, year, cover_key, cover_url, description,
  rating, created_at, enriched_at, media_format, list_status,
  progress_current, progress_total, personal_score, notes, tags
FROM media_items;

DROP TABLE media_items;
ALTER TABLE media_items_new RENAME TO media_items;

CREATE INDEX idx_media_items_kind ON media_items(kind);
CREATE INDEX idx_media_items_title ON media_items(normalized_title);
CREATE INDEX idx_media_items_list_status ON media_items(kind, list_status);

DROP TABLE links;
DROP TABLE external_ids;
