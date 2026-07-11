-- Initial D1 schema for medialib.
-- Runtime code should not create or alter tables; use D1 migrations instead.

CREATE TABLE IF NOT EXISTS artists (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     normalized_name TEXT NOT NULL UNIQUE,
     mbid TEXT,
     image_key TEXT,
     image_url TEXT,
     genres TEXT,
     enriched_at TEXT
   );

CREATE INDEX IF NOT EXISTS idx_artists_mbid ON artists(mbid);

CREATE TABLE IF NOT EXISTS albums (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     normalized_title TEXT NOT NULL,
     artist_id INTEGER REFERENCES artists(id),
     mbid TEXT,
     year INTEGER,
     cover_key TEXT,
     cover_url TEXT,
     rating INTEGER,
     enriched_at TEXT,
     UNIQUE(normalized_title, artist_id)
   );

CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);

CREATE TABLE IF NOT EXISTS tracks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     normalized_title TEXT NOT NULL,
     artist_id INTEGER REFERENCES artists(id),
     album_id INTEGER REFERENCES albums(id),
     duration_ms INTEGER,
     isrc TEXT,
     mbid TEXT,
     rating INTEGER,
     favorite INTEGER NOT NULL DEFAULT 0,
     UNIQUE(normalized_title, artist_id)
   );

CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);

CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);

CREATE INDEX IF NOT EXISTS idx_tracks_isrc ON tracks(isrc);

CREATE TABLE IF NOT EXISTS track_artists (
     track_id INTEGER NOT NULL REFERENCES tracks(id),
     artist_id INTEGER NOT NULL REFERENCES artists(id),
     position INTEGER NOT NULL DEFAULT 0,
     role TEXT NOT NULL DEFAULT 'main',
     PRIMARY KEY (track_id, artist_id)
   );

CREATE TABLE IF NOT EXISTS authors (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     normalized_name TEXT NOT NULL UNIQUE,
     olid TEXT,
     bio TEXT
   );

CREATE TABLE IF NOT EXISTS books (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     normalized_title TEXT NOT NULL,
     isbn TEXT,
     olid TEXT,
     year INTEGER,
     publisher TEXT,
     page_count INTEGER,
     cover_key TEXT,
     cover_url TEXT,
     description TEXT,
     reading_status TEXT,
     rating INTEGER,
     review TEXT,
     enriched_at TEXT,
     UNIQUE(normalized_title, isbn)
   );

CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn);

CREATE TABLE IF NOT EXISTS book_authors (
     book_id INTEGER NOT NULL REFERENCES books(id),
     author_id INTEGER NOT NULL REFERENCES authors(id),
     position INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (book_id, author_id)
   );

CREATE TABLE IF NOT EXISTS media_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,              -- movie | series | anime | manga
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
     UNIQUE(source, source_id),
     UNIQUE(kind, normalized_title)
   );

CREATE INDEX IF NOT EXISTS idx_media_items_kind ON media_items(kind);

CREATE INDEX IF NOT EXISTS idx_media_items_title ON media_items(normalized_title);

CREATE TABLE IF NOT EXISTS links (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     url TEXT NOT NULL,
     source TEXT NOT NULL,            -- spotify | youtube | bandcamp | goodreads | myanimelist
     source_kind TEXT,               -- track | album | artist | video | playlist | book | anime | manga
     source_id TEXT,                 -- canonical id within the source
     entity_type TEXT,               -- artist | album | track | book | movie | series | anime | manga
     entity_id INTEGER,              -- fk into the matching entity table
     title TEXT,                     -- denormalized display label
     status TEXT NOT NULL DEFAULT 'pending', -- pending | ok | error
     raw_json TEXT,
     saved_at TEXT NOT NULL DEFAULT (datetime('now')),
     saved_via TEXT NOT NULL DEFAULT 'web',  -- web | telegram
     UNIQUE(source, source_id)
   );

CREATE INDEX IF NOT EXISTS idx_links_saved_at ON links(saved_at);

CREATE INDEX IF NOT EXISTS idx_links_status ON links(status);

CREATE TABLE IF NOT EXISTS jobs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,             -- ingest | enrich | migrate
     status TEXT NOT NULL DEFAULT 'pending',
     items_total INTEGER NOT NULL DEFAULT 0,
     items_done INTEGER NOT NULL DEFAULT 0,
     message TEXT,
     payload_json TEXT,
     started_at TEXT NOT NULL DEFAULT (datetime('now')),
     finished_at TEXT
   );

CREATE TABLE IF NOT EXISTS kv (
     key TEXT PRIMARY KEY,
     value TEXT
   );

CREATE TABLE IF NOT EXISTS enrich_queue (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     entity_type TEXT NOT NULL,      -- artist | album | track | book | media
     entity_id INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE(entity_type, entity_id)
   );
