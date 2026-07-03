# medialib

Self-hosted personal media library — manage your music and books in one place.

## Features

### Music
- Import from **Spotify** (saved tracks + playlists) and **Bandcamp** (collection)
- Artist disaggregation: compound artist names like "03 Greedo, Kenny Beats" are split into individual artists with `main`/`featured` roles
- Browse by artist → album → track with cover art
- **Migrate** your library to **YouTube Music** (dry-run preview + background migration)
- **Enrich** via MusicBrainz (ISRC lookup → MBIDs, genres, release data) + Cover Art Archive (album art)

### Books
- Import by **ISBN** (fetches metadata + cover from Open Library)
- Upload **EPUB** files (parses title, author, ISBN, publisher from file metadata)
- Track reading status (want-to-read / reading / read) and rate books 1-5
- **Enrich** via Open Library (fills missing covers, descriptions, page counts)
- Browse by letter, search by title

### General
- FastAPI + SQLite + HTMX, all Python, no JS build step
- Background jobs with live progress bars (via HTMX polling)
- `uv` for dependency management

## Setup

```bash
cd medialib
uv sync
cp .env.example .env   # fill in your secrets
```

Requires Python 3.14 (see `.python-version`).

### Spotify
1. Create an app at https://developer.spotify.com
2. Add redirect URI `http://127.0.0.1:8000/callback/spotify`
3. Put client ID + secret in `.env`

### YouTube Music
```bash
uv run ytmusicapi setup oauth   # writes ./data/ytmusic_headers.json
```

### Bandcamp
Set `BANDCAMP_COOKIE` in `.env` (your logged-in session cookie from browser devtools).

## Run

```bash
uv run python -m uvicorn medialib.web.app:app --reload --port 8000
```

Open http://127.0.0.1:8000

## Layout

```
medialib/
  adapters/    spotify, youtube, bandcamp, musicbrainz, openlibrary, epub
  core/        db, models, match, catalog, book_catalog, jobs, migrate, artists
  web/         app, templates/
  data/        medialib.db, ytmusic_headers.json
```

## Tech

| Component | Choice |
|-----------|--------|
| Backend | FastAPI + SQLAlchemy |
| DB | SQLite |
| Frontend | Jinja2 + HTMX + Tailwind CDN |
| Music metadata | MusicBrainz + Cover Art Archive |
| Book metadata | Open Library |
| YT Music | ytmusicapi (unofficial) |
| Spotify | spotipy |
| EPUB parsing | ebooklib |
| Deps | uv |
