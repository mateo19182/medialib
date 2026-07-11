ALTER TABLE artists ADD COLUMN artist_type TEXT NOT NULL DEFAULT 'musician';

UPDATE artists SET artist_type = 'musician' WHERE artist_type IS NULL OR artist_type = '';
