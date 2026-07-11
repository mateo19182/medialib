# medialib on Cloudflare — clean-room rewrite plan

A single-user, self-hosted personal media library that runs entirely on Cloudflare.
You save music (Spotify / YouTube / Bandcamp) and books (Goodreads) by sending links
to a Telegram bot or adding them in a web UI; the app fetches rich metadata, enriches
it against canonical sources, caches artwork, and lets you browse, rate, and migrate
your music to YouTube Music.

> Clean-room rewrite. The existing Python app is reference-only for *what features
> exist*; no code is carried over. New stack, new project directory.

---

## 1. Goals & non-goals

**Goals**
- Save an item from a pasted link (Telegram or web) in one step, with rich metadata + cached art.
- Browse music by artist → album → track, and books by author/title.
- Rate items and track book reading status.
- Query the library from the Telegram bot (`/search`, `/recent`, `/stats`).
- Migrate saved music to a YouTube Music playlist.
- Zero servers to maintain; deploy with `wrangler deploy`; ~$0 at this scale.

**Non-goals (for now)**
- Historical Spotify/Goodreads bulk history import + Wrapped stats (explicitly deferred; the
  saved data export remains on disk and can feed a later phase).
- Multi-user / sharing.
- Streaming or hosting actual audio (we cache *artwork* and *EPUBs*, not songs).

---

## 2. Stack & Cloudflare primitives

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Workers** (TypeScript) | Serverless, scale-to-zero, `wrangler` deploys. |
| HTTP / routing | **Hono** | Tiny, Workers-native router + middleware + JSX. |
| Storage | **D1** (SQLite) | Single-user catalog with managed migrations and direct Worker access. |
| Migrations | **Wrangler D1 migrations** | Schema changes live in versioned SQL files. |
| File cache | **R2** | Cover art + EPUBs, so the library survives source link-rot. |
| Background work | **Cron trigger** (v1); **Queues/Workflows** if needed | Chunked, resumable enrichment + migration; respects rate limits. |
| Web auth | **Cloudflare Access** (SSO) | No app-level login code; you only. |
| Bot auth | Telegram user-ID allowlist + webhook secret | Bot ignores everyone but you. |
| HTML parsing | **HTMLRewriter** (native) + JSON-LD extraction | Scrape Bandcamp/Goodreads/Spotify pages without a DOM lib. |
| Secrets | `wrangler secret put` | Tokens/keys never in code. |
| Tests | **Vitest** + `@cloudflare/vitest-pool-workers` (Miniflare) | Unit + integration against a real Workers runtime. |

**Topology**

```
Telegram ──webhook──▶ Worker (Hono)
Browser ──CF Access─▶ Worker (Hono)  ───▶  D1 (catalog, links, jobs)
                         │
                         └── R2 (covers, epubs)
External: Spotify oEmbed+API · YouTube Data API · Bandcamp/Goodreads pages · MusicBrainz · OpenLibrary · Cover Art Archive · Google OAuth (migration)
```

The Worker is stateless glue; catalog state lives in D1. The library service exposes
methods (`saveLink`, `search`, `recent`, `stats`, `importChunk`) and scheduled events drain
enrichment work in small batches.

---

## 3. Data model (D1 SQLite)

Relational music model (browsable) + separate books, unified by a `links` table.

```
artists(id, name, normalized_name, mbid?, image_key?, image_url?, genres?, enriched_at?)
albums(id, title, normalized_title, artist_id?, mbid?, year?, cover_key?, cover_url?, rating?, enriched_at?)
tracks(id, title, normalized_title, artist_id?, album_id?, duration_ms?, isrc?, mbid?, rating?, favorite?)
track_artists(track_id, artist_id, position, role)          -- compound-artist splitting

authors(id, name, normalized_name, olid?, bio?)
books(id, title, normalized_title, isbn?, olid?, authors…, year?, publisher?, page_count?,
      cover_key?, cover_url?, description?, reading_status?, rating?, review?)
book_authors(book_id, author_id, position)

links(id, url, source, source_kind, entity_type, entity_id,   -- what a saved URL resolved to
      raw_json, saved_at, saved_via)                          -- source ∈ spotify|youtube|bandcamp|goodreads
                                                              -- entity_type ∈ artist|album|track|book
jobs(id, kind, status, items_total, items_done, message,      -- enrich/migrate/ingest progress
     payload_json, started_at, finished_at)
migration_state(playlist_id, cursor, added, skipped, quota_note)
oauth_tokens(provider, access_token, refresh_token, expires_at) -- Google, for migration
kv(key, value)                                                 -- misc (webhook secret rotation etc.)
```

Dedupe rules: canonical `(source, source_id)` on `links`; `isrc`/`mbid` on tracks; `mbid` on
albums/artists; `isbn`/`olid` on books. Compound artists (`"A, B feat. C"`) split into
individual `artists` + `track_artists` roles (main/featured), same idea as the old app.

---

## 4. Ingestion pipeline (the core)

`saveLink(url, via)`:

1. **Classify** — regex the URL → `{source, source_kind}`:
   - `open.spotify.com/(track|album|artist|playlist)/…`
   - `youtube.com/watch`, `youtu.be/…`, `music.youtube.com/…`, `…/playlist?list=`
   - `*.bandcamp.com/(track|album)/…`
   - `goodreads.com/book/show/…`
2. **Fast ack** (bot only) — reply “Saved ✓ enriching…”, insert a `links` row + minimal stub, enqueue enrichment. Never block the Telegram webhook on network fetches.
3. **Fetch base metadata** (per-source, §5).
4. **Enrich** — music → MusicBrainz (by ISRC or title+artist) for MBIDs/genres/tracklist + Cover Art Archive; books → OpenLibrary (by ISBN) for cover/description/pages.
5. **Cache art** — download cover (and EPUB if provided) → R2, store `*_key`.
6. **Upsert** into the relational model with dedupe; link the `links` row to the entity.
7. **Mark job done**; bot posts a follow-up “✓ *Title* — *Artist*”.

### 5. Per-source fetch strategy

| Source | Base fetch | Notes |
|---|---|---|
| **Spotify** | **oEmbed** (`open.spotify.com/oembed`) → title + thumbnail (verified working). | Catalog Web API returns **403** for this app, so we don’t rely on it for track/album detail. Playlists/saved via user OAuth still work if needed. Real metadata (tracklist, ISRC, genres) comes from **MusicBrainz** enrichment. |
| **YouTube** | **YouTube Data API** (`videos.list`, `playlists.list`, `playlistItems.list`) — reliable, free quota. | Single video → `track` (heuristic “Artist - Title” split); playlist → `album`/`playlist`. `music.youtube.com` shares the same IDs. |
| **Bandcamp** | Scrape page: embedded `data-tralbum` JSON + JSON-LD (`application/ld+json`) + `og:` tags via **HTMLRewriter**. | No API, but pages carry structured JSON-LD (name, byArtist, tracks, image). Robust enough; guarded with fallbacks. |
| **Goodreads** | Scrape page JSON-LD (schema.org `Book`: name, author, isbn, aggregateRating, image) + `og:` tags. | API shut down. Extract **ISBN → OpenLibrary** for canonical enrich + cover. Saved as a book with reading status. |

All fetches use a browser-like `User-Agent`, timeouts, and retry/backoff. Scrapers are isolated
per-source with a shared “extract JSON-LD / og-meta” helper so DOM changes touch one file.

---

## 6. Telegram bot

- **Webhook** at `POST /telegram/:secret` (secret path + `X-Telegram-Bot-Api-Secret-Token` header check).
- **Allowlist**: ignore any update whose `from.id` ≠ `TELEGRAM_ALLOWED_USER_ID`.
- **Ingest**: any message containing a supported URL → `saveLink(url, via="telegram")`, instant ack, async enrich, follow-up confirmation (edited message).
- **Commands**:
  - `/search <q>` — fuzzy search across tracks/albums/artists/books.
  - `/recent [n]` — last N saved items.
  - `/stats` — counts by source/type, recently enriched, pending jobs.
  - `/migrate` — kick off (or report status of) YouTube migration.
  - `/rate <id> <1-5>`, `/status <id> <want|reading|read>` — quick edits from the phone.
- Setup: `setWebhook` once; store token as a secret.

---

## 7. Web UI

Server-rendered Hono JSX + **HTMX** (keeps the old app’s “progressive, no SPA” feel; TS is
bundled by wrangler). Behind **Cloudflare Access**, so no login code.

Routes: `/` dashboard (counts, connect-status, quick-add box, migrate card) ·
`/library` (music, browse/search by artist, A–Z) · `/artist/:id` · `/album/:id` ·
`/track/:id` · `/books` · `/book/:id` · `/add` (paste-link form → `saveLink`) ·
`/jobs/:id/status` (HTMX poll fragment) · `/migrate` (preview + run). Ratings/status via
small HTMX `POST`s.

---

## 8. YouTube Music migration

- **Auth**: Google OAuth2 (YouTube Data API scope), refresh token stored in `oauth_tokens`.
- **Run**: create a playlist (`playlists.insert`) → for each saved track, `search.list` for the
  best video → `playlistItems.insert`. Progress tracked in `migration_state` + a `jobs` row.
- **Quota reality**: default 10 000 units/day; `search.list` = 100, `playlistItems.insert` = 50
  → ~**90 tracks/day**. So migration is **chunked across days via scheduled batches**, resuming from
  `cursor`. UI/bot shows “added X, N remaining, resumes tomorrow.” (Flagged as the main
  operational constraint; requesting a quota increase is optional.)

---

## 9. Background jobs & async model

- Telegram webhook and web requests **never block** on enrichment/migration.
- D1 holds a work queue; scheduled events do bounded batches (respecting MusicBrainz ~1 req/s
  and YT quota) and persist progress. Resumable across deploys/restarts — unlike the old
  daemon threads.
- If retry-durability or fan-out grows, promote enrichment to **Cloudflare Workflows** and/or
  ingestion to **Queues** while D1 stays the store of record.

---

## 10. Secrets & config

`wrangler secret put` for: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`,
`TELEGRAM_WEBHOOK_SECRET`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `YOUTUBE_API_KEY`,
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`. Bindings in `wrangler.jsonc`: D1
database, R2 bucket. CF Access policy protects all web routes except the Telegram webhook.

---

## 11. Project layout

```
src/
  index.ts                 # Hono app, route mounting, CF Access assumed
  db/library.ts            # D1 catalog service
  migrations/              # D1 schema migrations
  ingest/
    classify.ts            # URL → {source, kind}
    spotify.ts youtube.ts bandcamp.ts goodreads.ts
    enrich/musicbrainz.ts enrich/openlibrary.ts enrich/coverart.ts
    extract.ts             # shared JSON-LD / og-meta / HTMLRewriter helpers
  bot/telegram.ts          # webhook, allowlist, commands
  migrate/youtube.ts       # OAuth + playlist build (quota-aware)
  web/                     # Hono JSX pages + HTMX fragments
  r2.ts  util.ts
wrangler.jsonc  drizzle.config.ts  vitest.config.ts
```

---

## 12. Milestones

- **M0 — Scaffold**: wrangler + Hono + D1 migrations + R2 + CF Access; deploy “hello”.
- **M1 — Ingestion core**: classifier + Spotify(oEmbed) + YouTube(API) fetchers → D1 storage + dedupe; basic `/library` + `/add`.
- **M2 — Telegram bot**: secure webhook, ack+enqueue, follow-up confirm, `/search /recent /stats`.
- **M3 — Bandcamp + Goodreads** scrapers (HTMLRewriter/JSON-LD).
- **M4 — Enrichment + R2**: MusicBrainz + OpenLibrary + Cover Art via scheduled batches; cache covers/EPUBs.
- **M5 — Status & ratings**: fields + UI + bot commands.
- **M6 — YouTube migration**: OAuth, playlist build, quota-aware chunked resume.
- **M7 — Polish**: dashboard stats, error surfacing, retry hardening, tests.

---

## 13. Risks / watch-items

- **YT Data API quota** → migration is inherently slow (~90/day); chunk + resume, consider quota bump.
- **Scraper fragility** (Bandcamp/Goodreads DOM/JSON-LD changes) → isolate per source, prefer JSON-LD, add fallbacks + clear failure messages.
- **Spotify catalog 403** → already mitigated by leaning on MusicBrainz for real music metadata.
- **DO single-instance** → correct for single-user; would need rework only if multi-user later.
- **Telegram webhook timeout** → strictly ack-then-enqueue; no synchronous enrichment.

---

## 14. Open questions before M0

1. **Project location**: new sibling repo (e.g. `~/Work/personal/medialib-cf`) or a fresh subdir here, leaving the Python app untouched for reference?
2. **Domain**: custom domain on your Cloudflare account, or `*.workers.dev` to start?
3. **Compound-artist splitting**: keep the old “03 Greedo, Kenny Beats → main/featured” behavior? (Assumed yes.)
4. **Goodreads reading status**: seed from the link when the page exposes your shelf, or always default to “want-to-read” and set manually? (Assumed manual.)
```
