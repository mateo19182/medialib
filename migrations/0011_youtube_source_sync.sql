CREATE TABLE IF NOT EXISTS youtube_sync_playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  scan_limit INTEGER NOT NULL DEFAULT 3,
  stop_after_known INTEGER NOT NULL DEFAULT 25,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_youtube_sync_playlists_enabled
  ON youtube_sync_playlists(enabled, id);

CREATE TABLE IF NOT EXISTS youtube_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'running',
  mode TEXT NOT NULL DEFAULT 'incremental',
  playlists_total INTEGER NOT NULL DEFAULT 0,
  playlists_done INTEGER NOT NULL DEFAULT 0,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  items_seen INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS youtube_sync_items (
  playlist_id TEXT NOT NULL,
  playlist_item_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  item_source_id INTEGER REFERENCES item_sources(id) ON DELETE SET NULL,
  item_kind TEXT,
  item_id INTEGER,
  title TEXT,
  channel_title TEXT,
  position INTEGER,
  raw_json TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at TEXT,
  PRIMARY KEY (playlist_id, playlist_item_id)
);

CREATE INDEX IF NOT EXISTS idx_youtube_sync_items_playlist_video
  ON youtube_sync_items(playlist_id, video_id);
CREATE INDEX IF NOT EXISTS idx_youtube_sync_items_source
  ON youtube_sync_items(item_source_id);
