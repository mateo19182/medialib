CREATE TABLE IF NOT EXISTS live_shows (
  slug TEXT PRIMARY KEY,
  artist TEXT NOT NULL,
  date TEXT,
  date_label TEXT NOT NULL,
  venue TEXT NOT NULL DEFAULT '',
  city TEXT,
  context TEXT,
  companions TEXT,
  summary TEXT NOT NULL DEFAULT '',
  notes_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_live_shows_date ON live_shows(date DESC);
