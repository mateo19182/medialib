CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,
  scope TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS youtube_migration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  playlist_id TEXT,
  playlist_url TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  items_total INTEGER NOT NULL DEFAULT 0,
  items_done INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  quota_day TEXT,
  quota_used INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS youtube_migration_items (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  query TEXT NOT NULL,
  title TEXT NOT NULL,
  artists TEXT NOT NULL,
  video_id TEXT,
  video_title TEXT,
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  added_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_youtube_migration_items_status
  ON youtube_migration_items(status, track_id);
