# MediaLib

[Source](https://github.com/mateo19182/medialib) | [Private deployment](https://medialib.m19182.dev)

Self-hosted personal media library on Cloudflare. Save music (Spotify / YouTube /
Bandcamp), books (Goodreads), anime/manga (MyAnimeList), and webtoons (WEBTOON)
by sending a link to
a Telegram bot or adding it in the web UI. The Add page also accepts a manual
artist, album, track, book, movie, series, anime, manga, webtoon, or comic entry; the app fetches rich metadata,
enriches it, caches artwork in R2, and lets you browse, rate, and migrate your
music to YouTube Music.

Single-user. Runs entirely on Workers + D1 (SQLite) + R2.

See [`PLAN.md`](./PLAN.md) for the full architecture and milestones. The previous
Python/FastAPI implementation is preserved on the `legacy` branch.

## Stack

- **Workers** + **Hono** (TypeScript)
- **D1** — owns the catalog with migrations managed by Wrangler
- **Cron trigger** — drains small enrichment batches from D1
- **R2** — cached cover art / EPUBs
- **Cloudflare Access** (web) + Telegram user-ID allowlist (bot)

## Develop

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in secrets for local dev
pnpm dev                         # wrangler dev (local): http://localhost:8787
pnpm test                        # vitest against the Workers runtime
pnpm typecheck
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
pnpm deploy
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

Use `/live` to add a live show. The bot will prompt for a pipe-separated entry:
`Artist | YYYY-MM-DD | Venue | City | Summary | Notes | tags`. Only the artist
is required. The same form is available from the `Add live show` button on
`/add`.

## Imports and Sync

Linkwarden is the source of truth for saved links. The app links directly to the
Linkwarden interface and does not proxy or copy bookmarks into D1.

The catalog uses one `ItemKind` vocabulary (`author`, `artist`, `album`, `track`, `book`,
`movie`, `series`, `anime`, `manga`, `webtoon`, and `comic`) and one provider
axis. Saved links and provider-owned identifiers live together in
`item_sources`; a non-null `saved_at` marks a source explicitly saved by the
user. MusicBrainz/Deezer enrich music, Open Library enriches books, Jikan
enriches MyAnimeList anime and manga, and TMDB enriches movies and series.

MyAnimeList XML exports can be converted to D1 SQL with:

```bash
node scripts/import-mal-export.mjs ~/Downloads/mangalist.xml.gz ~/Downloads/animelist.xml.gz > /tmp/mal-import.sql
wrangler d1 execute medialib-db --remote --file /tmp/mal-import.sql
```

On Node versions where Wrangler file upload hits a file-handle bug, split the SQL
into smaller `--command` chunks.

WEBTOON saved-list HTML can be converted to D1 SQL with:

```bash
node scripts/import-webtoon-list.mjs ~/Downloads/webtoons.html > /tmp/webtoon-import.sql
wrangler d1 execute medialib-db --remote --file /tmp/webtoon-import.sql
```

The importer reads `<ul class="my_list _card_list">` entries, stores them as
`kind = 'webtoon'`, and uses `data-title-no` as the stable WEBTOON identifier.

## YouTube Music migration

The `/migrate` page moves saved tracks into a private YouTube Music playlist.
It uses `YOUTUBE_API_KEY` for video search and Google OAuth for account writes.

Google OAuth setup:

- OAuth client type: Web application
- Redirect URI: `https://medialib.m19182.dev/oauth/google/callback`
- Required secrets: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
  `YOUTUBE_API_KEY`

Apply the latest D1 migration and deploy:

```bash
wrangler d1 migrations apply medialib-db --remote
wrangler secret put YOUTUBE_API_KEY
wrangler secret put GOOGLE_OAUTH_CLIENT_ID
wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
pnpm deploy
```

Then open `/migrate`, connect Google, and start the migration. Progress is
stored in D1 and drained in small cron batches so the job resumes across deploys
and respects the daily YouTube quota budget.
