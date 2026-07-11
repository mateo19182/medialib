-- Keep provider-owned IDs separately from local row IDs. A record may carry
-- several IDs (for example a MusicBrainz recording ID and an ISRC), but only
-- one is marked primary for each catalog entity.
CREATE TABLE external_ids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_url TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_type, provider, external_id),
  UNIQUE(entity_type, entity_id, provider)
);

CREATE UNIQUE INDEX idx_external_ids_primary_entity
  ON external_ids(entity_type, entity_id) WHERE is_primary = 1;
CREATE INDEX idx_external_ids_entity ON external_ids(entity_type, entity_id);

-- Preserve the identifiers already present in the original schema.
INSERT OR IGNORE INTO external_ids (entity_type, entity_id, provider, external_id, is_primary)
SELECT 'artist', id, 'musicbrainz', mbid, 1 FROM artists WHERE mbid IS NOT NULL AND mbid <> '';
INSERT OR IGNORE INTO external_ids (entity_type, entity_id, provider, external_id, is_primary)
SELECT 'album', id, 'musicbrainz-release', mbid, 1 FROM albums WHERE mbid IS NOT NULL AND mbid <> '';
INSERT OR IGNORE INTO external_ids (entity_type, entity_id, provider, external_id, is_primary)
SELECT 'track', id, 'musicbrainz-recording', mbid, 1 FROM tracks WHERE mbid IS NOT NULL AND mbid <> '';
INSERT OR IGNORE INTO external_ids (entity_type, entity_id, provider, external_id)
SELECT 'track', id, 'isrc', isrc FROM tracks WHERE isrc IS NOT NULL AND isrc <> '';
INSERT OR IGNORE INTO external_ids (entity_type, entity_id, provider, external_id, is_primary)
SELECT 'author', id, 'openlibrary', olid, 1 FROM authors WHERE olid IS NOT NULL AND olid <> '';
INSERT OR IGNORE INTO external_ids (entity_type, entity_id, provider, external_id, is_primary)
SELECT 'book', id, 'openlibrary', olid, 1 FROM books WHERE olid IS NOT NULL AND olid <> '';
INSERT OR IGNORE INTO external_ids (entity_type, entity_id, provider, external_id)
SELECT 'book', id, 'isbn', isbn FROM books WHERE isbn IS NOT NULL AND isbn <> '';
INSERT OR IGNORE INTO external_ids (entity_type, entity_id, provider, external_id, external_url, is_primary)
SELECT 'book', entity_id, 'goodreads', source_id, url, 1
FROM links WHERE source = 'goodreads' AND source_kind = 'book' AND entity_id IS NOT NULL;
INSERT OR IGNORE INTO external_ids (entity_type, entity_id, provider, external_id, external_url, is_primary)
SELECT kind, id, source || ':' || kind, source_id, source_url, 1
FROM media_items
WHERE source IS NOT NULL AND source <> 'manual' AND source_id IS NOT NULL AND source_id <> '';

-- Existing imports predate automatic enrichment. Queue entries without an
-- image so scheduled work fills their cover and canonical provider identity.
INSERT OR IGNORE INTO enrich_queue (entity_type, entity_id)
SELECT 'artist', id FROM artists WHERE image_key IS NULL;
INSERT OR IGNORE INTO enrich_queue (entity_type, entity_id)
SELECT 'album', id FROM albums WHERE cover_key IS NULL;
INSERT OR IGNORE INTO enrich_queue (entity_type, entity_id)
SELECT 'book', id FROM books WHERE cover_key IS NULL;
INSERT OR IGNORE INTO enrich_queue (entity_type, entity_id)
SELECT 'media', id FROM media_items WHERE cover_key IS NULL;
