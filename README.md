# medialib

Self-hosted personal media library on Cloudflare. Save music (Spotify / YouTube /
Bandcamp), books (Goodreads), and anime/manga (MyAnimeList) by sending a link to
a Telegram bot or adding it in the web UI. The Add page also accepts a manual
artist, album, track, book, movie, series, anime, or manga entry; the app fetches rich metadata,
enriches it, caches artwork in R2, and lets you browse, rate, and migrate your
music to YouTube Music.

Single-user. Runs entirely on Workers + D1 (SQLite) + R2.

See [`PLAN.md`](./PLAN.md) for the full architecture and milestones. The previous

Python/FastAPI implementation is preserved on the `**legacy**` branch.

## Stack

- **Workers** + **Hono** (TypeScript)
- **D1** — owns the catalog with migrations managed by Wrangler
- **Cron trigger** — drains small enrichment batches from D1
- **R2** — cached cover art / EPUBs
- **Cloudflare Access** (web) + Telegram user-ID allowlist (bot)

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in secrets for local dev
npm run dev                      # wrangler dev (local): http://localhost:8787
npm test                         # vitest against the Workers runtime
npm run typecheck
```

## Deploy

```bash
wrangler login
wrangler r2 bucket create medialib-media
wrangler d1 create medialib-db
wrangler d1 migrations apply medialib-db --remote
# set each secret listed in .dev.vars.example:
wrangler secret put TELEGRAM_BOT_TOKEN
# ...etc
npm run deploy
```

For automatic movie and series matching, add a TMDB API read-access token:

```bash
wrangler secret put TMDB_API_TOKEN
```

Deploys to `*.workers.dev` to start; wire a custom domain + Cloudflare Access later.

## Telegram bot

Send a supported link to save it directly. For an item you only know by name,
send `/add`, choose its type, then send the title or name. The bot searches
Deezer (music), Open Library (books), TMDB (movies and series), or Jikan
(anime and manga); if it cannot confirm a match, it saves the text as an
unverified item instead.

## Imports and Sync

Linkwarden is the source of truth for saved links. The app links directly to the
Linkwarden interface and does not proxy or copy bookmarks into D1.

Every catalog record has a local ID plus provider-owned identifiers in the
`external_ids` table. Existing coverless records are queued by migration
`0005`: MusicBrainz/Deezer enrich music, Open Library enriches books, Jikan
enriches MyAnimeList anime and manga, and TMDB enriches movies and series.

MyAnimeList XML exports can be converted to D1 SQL with:

```bash
node scripts/import-mal-export.mjs ~/Downloads/mangalist.xml.gz ~/Downloads/animelist.xml.gz > /tmp/mal-import.sql
wrangler d1 execute medialib-db --remote --file /tmp/mal-import.sql
```

On Node versions where Wrangler file upload hits a file-handle bug, split the SQL
into smaller `--command` chunks.

## yt music migration missing
