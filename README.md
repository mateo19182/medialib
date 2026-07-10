# medialib

Self-hosted personal media library on Cloudflare. Save music (Spotify / YouTube /
Bandcamp) and books (Goodreads) by sending a link to a Telegram bot or adding it in
the web UI; the app fetches rich metadata, enriches it, caches artwork in R2, and lets
you browse, rate, and migrate your music to YouTube Music.

Single-user. Runs entirely on Workers + one Durable Object (SQLite) + R2.

See [`PLAN.md`](./PLAN.md) for the full architecture and milestones. The previous
Python/FastAPI implementation is preserved on the **`legacy`** branch.

## Stack

- **Workers** + **Hono** (TypeScript)
- **Durable Object** with embedded **SQLite** — owns the whole catalog + runs background jobs via alarms
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
# set each secret listed in .dev.vars.example:
wrangler secret put TELEGRAM_BOT_TOKEN
# ...etc
npm run deploy
```

Deploys to `*.workers.dev` to start; wire a custom domain + Cloudflare Access later.
