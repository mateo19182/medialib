/**
 * SQLite schema for the Library Durable Object.
 *
 * Applied idempotently in the DO constructor via `CREATE TABLE IF NOT EXISTS`.
 * Relational music model (artist -> album -> track, browsable) + separate books,
 * unified by a `links` table that records what each saved URL resolved to.
 */
export const SCHEMA: string[] = [
  // --- music ---------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS artists (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     normalized_name TEXT NOT NULL UNIQUE,
     mbid TEXT,
     image_key TEXT,
     image_url TEXT,
     genres TEXT,
     enriched_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_artists_mbid ON artists(mbid)`,

  `CREATE TABLE IF NOT EXISTS albums (
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
   )`,
  `CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id)`,

  `CREATE TABLE IF NOT EXISTS tracks (
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
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tracks_isrc ON tracks(isrc)`,

  `CREATE TABLE IF NOT EXISTS track_artists (
     track_id INTEGER NOT NULL REFERENCES tracks(id),
     artist_id INTEGER NOT NULL REFERENCES artists(id),
     position INTEGER NOT NULL DEFAULT 0,
     role TEXT NOT NULL DEFAULT 'main',
     PRIMARY KEY (track_id, artist_id)
   )`,

  // --- books ----------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS authors (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     normalized_name TEXT NOT NULL UNIQUE,
     olid TEXT,
     bio TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS books (
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
   )`,
  `CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn)`,

  `CREATE TABLE IF NOT EXISTS book_authors (
     book_id INTEGER NOT NULL REFERENCES books(id),
     author_id INTEGER NOT NULL REFERENCES authors(id),
     position INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (book_id, author_id)
   )`,

  // --- saved links + jobs ---------------------------------------------------
  `CREATE TABLE IF NOT EXISTS links (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     url TEXT NOT NULL,
     source TEXT NOT NULL,            -- spotify | youtube | bandcamp | goodreads
     source_kind TEXT,               -- track | album | artist | video | playlist | book
     source_id TEXT,                 -- canonical id within the source
     entity_type TEXT,               -- artist | album | track | book
     entity_id INTEGER,              -- fk into the matching entity table
     status TEXT NOT NULL DEFAULT 'pending', -- pending | enriched | error
     raw_json TEXT,
     saved_at TEXT NOT NULL DEFAULT (datetime('now')),
     saved_via TEXT NOT NULL DEFAULT 'web',  -- web | telegram
     UNIQUE(source, source_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_links_saved_at ON links(saved_at)`,
  `CREATE INDEX IF NOT EXISTS idx_links_status ON links(status)`,

  `CREATE TABLE IF NOT EXISTS jobs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,             -- ingest | enrich | migrate
     status TEXT NOT NULL DEFAULT 'pending',
     items_total INTEGER NOT NULL DEFAULT 0,
     items_done INTEGER NOT NULL DEFAULT 0,
     message TEXT,
     payload_json TEXT,
     started_at TEXT NOT NULL DEFAULT (datetime('now')),
     finished_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS kv (
     key TEXT PRIMARY KEY,
     value TEXT
   )`,
];
