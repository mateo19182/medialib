-- The primary key starts with track_id; artist views also need the reverse lookup.
CREATE INDEX IF NOT EXISTS idx_track_artists_artist ON track_artists(artist_id, track_id);
