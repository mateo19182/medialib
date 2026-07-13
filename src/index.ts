import { Hono } from "hono";
import { liveShows } from "./live-shows";
import type { Env } from "./types";
import { getLibrary } from "./types";
import {
  addPage,
  albumPage,
  ARTIST_TYPE_LABELS,
  artistPage,
  bookPage,
  booksPage,
  dashboard,
  editEntryPage,
  favBtn,
  libraryPage,
  liveShowsPage,
  mediaItemPage,
  mediaListPage,
  migratePage,
  searchPage,
  stars,
  trackPage,
  youtubeSyncPage,
  type MusicView,
} from "./web/pages";
import { READING_STATUSES, type LiveShowInput, type RatableKind, type ReadingStatus } from "./db/library";
import type { ArtistType, VisualKind } from "./ingest/types";
import { handleWebhook, registerWebhook } from "./bot/telegram";
import { isTextAddKind } from "./ingest/text";
import { normalize } from "./util";
import { googleAuthorizationUrl, handleGoogleOAuthCallback, runYouTubeMigrationBatch } from "./migrate/youtube";
import { fetchYouTubePlaylistTitle, runYouTubeSourceSync, youtubePlaylistIdFromInput } from "./sync/youtube";

export { Library } from "./do/legacy";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const started = performance.now();
  await next();
  c.header("Server-Timing", `app;dur=${(performance.now() - started).toFixed(1)}`);
});

app.get("/health", (c) => c.json({ status: "ok" }));

// Cached cover art / images from R2.
app.get("/media/:key{.+}", async (c) => {
  const obj = await c.env.MEDIA.get(c.req.param("key"));
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
});

app.get("/", async (c) => {
  return c.html(dashboard(await getLibrary(c.env).stats()));
});

app.get("/migrate", async (c) => {
  const lib = getLibrary(c.env);
  const [status, token] = await Promise.all([lib.youtubeMigrationStatus(), lib.getOAuthToken("google")]);
  return c.html(migratePage(status, !!token, c.req.query("message") ?? ""));
});

app.get("/youtube-sync", async (c) => {
  const lib = getLibrary(c.env);
  const [playlists, run, token] = await Promise.all([
    lib.listYoutubeSyncPlaylists(),
    lib.recentYoutubeSyncRun(),
    lib.getOAuthToken("google"),
  ]);
  return c.html(youtubeSyncPage(playlists, run, !!token, c.req.query("message") ?? ""));
});

app.get("/oauth/google/start", async (c) => {
  try {
    return c.redirect(await googleAuthorizationUrl(c.env, new URL(c.req.url).origin, c.req.query("next") ?? "/migrate"), 302);
  } catch (error) {
    return c.html(migratePage(await getLibrary(c.env).youtubeMigrationStatus(), false, error instanceof Error ? error.message : String(error)), 500);
  }
});

app.get("/oauth/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing OAuth code or state", 400);
  try {
    const returnTo = await handleGoogleOAuthCallback(c.env, new URL(c.req.url).origin, code, state);
    const separator = returnTo.includes("?") ? "&" : "?";
    return c.redirect(`${returnTo}${separator}message=Google%20connected`, 303);
  } catch (error) {
    return c.text(error instanceof Error ? error.message : String(error), 400);
  }
});

app.post("/migrate/start", async (c) => {
  const lib = getLibrary(c.env);
  const reset = c.req.query("reset") === "1";
  await lib.startYoutubeMigration(reset);
  c.executionCtx.waitUntil(runYouTubeMigrationBatch(c.env, YOUTUBE_MIGRATION_BATCH_SIZE));
  return c.redirect("/migrate?message=Migration%20started", 303);
});

app.post("/migrate/run", async (c) => {
  const limit = Math.max(1, Math.min(10, Number(c.req.query("limit") ?? YOUTUBE_MIGRATION_BATCH_SIZE)));
  const result = await runYouTubeMigrationBatch(c.env, limit);
  const message = encodeURIComponent(result.message ?? `Batch processed ${result.processed} track${result.processed === 1 ? "" : "s"}`);
  return c.redirect(`/migrate?message=${message}`, 303);
});

app.post("/youtube-sync/playlists", async (c) => {
  const body = await c.req.parseBody();
  const playlistId = youtubePlaylistIdFromInput(String(body.playlist ?? ""));
  if (!playlistId) return c.redirect("/youtube-sync?message=Enter%20a%20playlist%20URL%20or%20ID", 303);
  let title = String(body.title ?? "").trim();
  if (!title && await getLibrary(c.env).getOAuthToken("google")) {
    title = await fetchYouTubePlaylistTitle(c.env, playlistId).catch(() => "") ?? "";
  }
  await getLibrary(c.env).upsertYoutubeSyncPlaylist({
    playlistId,
    title,
    scanLimit: Number(body.scanLimit ?? 3),
    stopAfterKnown: Number(body.stopAfterKnown ?? 25),
  });
  return c.redirect("/youtube-sync?message=Playlist%20saved", 303);
});

app.post("/youtube-sync/playlists/:id", async (c) => {
  const body = await c.req.parseBody();
  await getLibrary(c.env).updateYoutubeSyncPlaylist(Number(c.req.param("id")), {
    title: String(body.title ?? "").trim(),
    enabled: body.enabled === "1",
    scanLimit: Number(body.scanLimit ?? 3),
    stopAfterKnown: Number(body.stopAfterKnown ?? 25),
  });
  return c.redirect("/youtube-sync?message=Playlist%20updated", 303);
});

app.post("/youtube-sync/playlists/:id/delete", async (c) => {
  await getLibrary(c.env).deleteYoutubeSyncPlaylist(Number(c.req.param("id")));
  return c.redirect("/youtube-sync?message=Playlist%20deleted", 303);
});

app.post("/youtube-sync/run", async (c) => {
  const playlist = c.req.query("playlist");
  const result = await runYouTubeSourceSync(c.env, { playlistDbId: playlist ? Number(playlist) : undefined });
  return c.redirect(`/youtube-sync?message=${encodeURIComponent(result.message ?? "Sync complete")}`, 303);
});

const pageNumber = (value: string | undefined): number => Math.max(1, Math.floor(Number(value) || 1));
const PAGE_SIZE = 50;
const YOUTUBE_MIGRATION_BATCH_SIZE = 10;

app.get("/library", async (c) => {
  const requested = c.req.query("view");
  const view: MusicView = requested === "tracks" || requested === "albums" ? requested : "artists";
  const lib = getLibrary(c.env);
  const page = pageNumber(c.req.query("page"));
  const offset = (page - 1) * PAGE_SIZE;
  const result = view === "artists" ? await lib.listArtists(PAGE_SIZE, offset)
    : view === "albums" ? await lib.listAlbums(PAGE_SIZE, offset)
      : await lib.listTracks(PAGE_SIZE, offset);
  return c.html(libraryPage(view, result));
});

app.get("/artist/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const detail = await getLibrary(c.env).artistDetail(id);
  if (!detail) return c.notFound();
  return c.html(artistPage(detail));
});

app.get("/album/:id", async (c) => {
  const detail = await getLibrary(c.env).albumDetail(Number(c.req.param("id")));
  if (!detail) return c.notFound();
  return c.html(albumPage(detail));
});

app.get("/track/:id", async (c) => {
  const detail = await getLibrary(c.env).trackDetail(Number(c.req.param("id")));
  if (!detail) return c.notFound();
  return c.html(trackPage(detail));
});

app.get("/search", async (c) => {
  const q = String(c.req.query("q") ?? "").trim();
  const results = q ? await getLibrary(c.env).search(q, 30) : [];
  return c.html(searchPage(q, results));
});

app.get("/add", (c) => c.html(addPage()));

app.post("/add", async (c) => {
  const body = await c.req.parseBody();
  const url = String(body.url ?? "").trim();
  const kind = String(body.kind ?? "");
  const title = String(body.title ?? "").trim();
  const creator = String(body.creator ?? "").trim();
  const artistType = String(body.artistType ?? "musician").trim();
  let result;
  try {
    result = url
      ? await getLibrary(c.env).saveLink(url, "web")
      : isTextAddKind(kind)
        ? await getLibrary(c.env).saveText(kind, title, "web", creator, artistType as ArtistType)
        : { ok: false, error: "Choose a media type" };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return c.html(addPage(result));
});

app.get("/books", async (c) => {
  const page = pageNumber(c.req.query("page"));
  return c.html(booksPage(await getLibrary(c.env).listBooks(PAGE_SIZE, (page - 1) * PAGE_SIZE)));
});

app.get("/live", async (c) => {
  const lib = getLibrary(c.env);
  await lib.seedLiveShows(liveShows);
    const [artists, shows] = await Promise.all([lib.listArtists(100, 0), lib.listLiveShows()]);
    const byName = new Map(artists.items.map((artist) => [normalize(artist.name), artist]));
  const links = new Map(shows.flatMap((show) => {
    const artist = byName.get(normalize(show.artist));
    return artist ? [[show.slug, artist] as const] : [];
  }));
  return c.html(liveShowsPage(shows, links));
});

const text = (body: Record<string, unknown>, key: string) => String(body[key] ?? "").trim();
const number = (body: Record<string, unknown>, key: string) => { const value = text(body, key); const parsed = Number(value); return value && Number.isFinite(parsed) ? parsed : null; };

app.get("/edit/artist/:id", async (c) => {
  const id = Number(c.req.param("id")); const detail = await getLibrary(c.env).artistDetail(id); if (!detail) return c.notFound();
  return c.html(editEntryPage("artist", `/artist/${id}`, `/edit/artist/${id}`, [{ name: "name", label: "Name", value: detail.artist.name }, { name: "artistType", label: "Type", value: detail.artist.artist_type, type: "select", options: ARTIST_TYPE_LABELS }, { name: "genres", label: "Genres", value: detail.artist.genres }, { name: "imageUrl", label: "Image URL", value: detail.artist.image_url }], `/delete/artist/${id}`));
});
app.post("/edit/artist/:id", async (c) => { const id = Number(c.req.param("id")); const body = await c.req.parseBody(); await getLibrary(c.env).updateArtist(id, { name: text(body, "name"), artistType: text(body, "artistType") as ArtistType, genres: text(body, "genres"), imageUrl: text(body, "imageUrl") }); return c.redirect(`/artist/${id}`, 303); });

app.get("/edit/album/:id", async (c) => { const id = Number(c.req.param("id")); const detail = await getLibrary(c.env).albumDetail(id); if (!detail) return c.notFound(); return c.html(editEntryPage("album", `/album/${id}`, `/edit/album/${id}`, [{ name: "title", label: "Title", value: detail.album.title }, { name: "artist", label: "Artist", value: detail.album.artist }, { name: "year", label: "Year", value: detail.album.year, type: "number" }], `/delete/album/${id}`)); });
app.post("/edit/album/:id", async (c) => { const id = Number(c.req.param("id")); const b = await c.req.parseBody(); await getLibrary(c.env).updateAlbum(id, { title: text(b, "title"), artist: text(b, "artist"), year: number(b, "year") }); return c.redirect(`/album/${id}`, 303); });

app.get("/edit/track/:id", async (c) => { const id = Number(c.req.param("id")); const detail = await getLibrary(c.env).trackDetail(id); if (!detail) return c.notFound(); return c.html(editEntryPage("track", `/track/${id}`, `/edit/track/${id}`, [{ name: "title", label: "Title", value: detail.track.title }, { name: "artists", label: "Artists", value: detail.artists.map((artist) => artist.name).join(", "), hint: "Use commas for collaborators; add feat. for featured artists." }, { name: "album", label: "Album", value: detail.track.album }, { name: "durationMs", label: "Duration (milliseconds)", value: detail.track.duration_ms, type: "number" }], `/delete/track/${id}`)); });
app.post("/edit/track/:id", async (c) => { const id = Number(c.req.param("id")); const b = await c.req.parseBody(); await getLibrary(c.env).updateTrack(id, { title: text(b, "title"), artists: text(b, "artists"), album: text(b, "album"), durationMs: number(b, "durationMs") }); return c.redirect(`/track/${id}`, 303); });

app.get("/edit/book/:id", async (c) => { const id = Number(c.req.param("id")); const b = await getLibrary(c.env).bookDetail(id); if (!b) return c.notFound(); return c.html(editEntryPage("book", `/book/${id}`, `/edit/book/${id}`, [{ name: "title", label: "Title", value: b.title }, { name: "authors", label: "Authors", value: b.author }, { name: "year", label: "Year", value: b.year, type: "number" }, { name: "publisher", label: "Publisher", value: b.publisher }, { name: "pageCount", label: "Pages", value: b.page_count, type: "number" }, { name: "isbn", label: "ISBN", value: b.isbn }, { name: "description", label: "Description", value: b.description, multiline: true }], `/delete/book/${id}`)); });
app.post("/edit/book/:id", async (c) => { const id = Number(c.req.param("id")); const b = await c.req.parseBody(); await getLibrary(c.env).updateBook(id, { title: text(b, "title"), authors: text(b, "authors"), year: number(b, "year"), publisher: text(b, "publisher"), pageCount: number(b, "pageCount"), isbn: text(b, "isbn"), description: text(b, "description") }); return c.redirect(`/book/${id}`, 303); });

app.get("/edit/media/:id", async (c) => { const id = Number(c.req.param("id")); const m = await getLibrary(c.env).mediaDetail(id); if (!m) return c.notFound(); return c.html(editEntryPage(m.kind, `/item/${id}`, `/edit/media/${id}`, [{ name: "title", label: "Title", value: m.title }, { name: "year", label: "Year", value: m.year, type: "number" }, { name: "format", label: "Format", value: m.media_format }, { name: "status", label: "Status", value: m.list_status }, { name: "progressCurrent", label: "Progress current", value: m.progress_current, type: "number" }, { name: "progressTotal", label: "Progress total", value: m.progress_total, type: "number" }, { name: "personalScore", label: "Personal score", value: m.personal_score, type: "number" }, { name: "tags", label: "Tags", value: m.tags }, { name: "description", label: "Description", value: m.description, multiline: true }, { name: "notes", label: "Notes", value: m.notes, multiline: true }], `/delete/media/${id}`)); });
app.post("/edit/media/:id", async (c) => { const id = Number(c.req.param("id")); const b = await c.req.parseBody(); await getLibrary(c.env).updateMedia(id, { title: text(b, "title"), year: number(b, "year"), format: text(b, "format"), status: text(b, "status"), progressCurrent: number(b, "progressCurrent"), progressTotal: number(b, "progressTotal"), personalScore: number(b, "personalScore"), tags: text(b, "tags"), description: text(b, "description"), notes: text(b, "notes") }); return c.redirect(`/item/${id}`, 303); });

app.post("/delete/:kind/:id", async (c) => { const kind = c.req.param("kind"); if (!["artist", "album", "track", "book", "media"].includes(kind)) return c.notFound(); await getLibrary(c.env).deleteEntry(kind as "artist" | "album" | "track" | "book" | "media", Number(c.req.param("id"))); const destination = kind === "artist" || kind === "album" || kind === "track" ? "/library" : kind === "book" ? "/books" : "/"; return c.redirect(destination, 303); });

const liveInput = (body: Record<string, unknown>): LiveShowInput => ({ artist: text(body, "artist"), date: text(body, "date"), dateLabel: text(body, "dateLabel"), venue: text(body, "venue"), city: text(body, "city"), context: text(body, "context"), companions: text(body, "companions"), summary: text(body, "summary"), notes: text(body, "notes"), tags: text(body, "tags") });
const liveFields = (show?: import("./live-shows").LiveShow) => [{ name: "artist", label: "Artist", value: show?.artist, required: true }, { name: "date", label: "Date", value: show?.date, type: "date" as const }, { name: "dateLabel", label: "Date label", value: show?.dateLabel }, { name: "venue", label: "Venue", value: show?.venue }, { name: "city", label: "City", value: show?.city }, { name: "context", label: "Context", value: show?.context }, { name: "companions", label: "Companions", value: show?.companions }, { name: "summary", label: "Summary", value: show?.summary, multiline: true }, { name: "notes", label: "Notes", value: show?.notes.join("\n"), multiline: true, hint: "One note per line." }, { name: "tags", label: "Tags", value: show?.tags.join(", "), hint: "Comma-separated." }];
app.get("/live/add", (c) => c.html(editEntryPage("live show", "/live", "/live/add", liveFields())));
app.post("/live/add", async (c) => { const lib = getLibrary(c.env); await lib.seedLiveShows(liveShows); const slug = await lib.createLiveShow(liveInput(await c.req.parseBody())); return c.redirect(`/live/${slug}/edit`, 303); });
app.get("/live/:slug/edit", async (c) => { const lib = getLibrary(c.env); await lib.seedLiveShows(liveShows); const show = await lib.liveShow(c.req.param("slug")); if (!show) return c.notFound(); return c.html(editEntryPage("live show", "/live", `/live/${show.slug}/edit`, liveFields(show), `/live/${show.slug}/delete`)); });
app.post("/live/:slug/edit", async (c) => { const lib = getLibrary(c.env); await lib.updateLiveShow(c.req.param("slug"), liveInput(await c.req.parseBody())); return c.redirect("/live", 303); });
app.post("/live/:slug/delete", async (c) => { await getLibrary(c.env).deleteLiveShow(c.req.param("slug")); return c.redirect("/live", 303); });

app.get("/book/:id", async (c) => {
  const detail = await getLibrary(c.env).bookDetail(Number(c.req.param("id")));
  if (!detail) return c.notFound();
  return c.html(bookPage(detail));
});

const MEDIA_ROUTES: Record<string, VisualKind> = { movies: "movie", series: "series", anime: "anime", manga: "manga", webtoons: "webtoon", comics: "comic" };

for (const [path, kind] of Object.entries(MEDIA_ROUTES)) {
  app.get(`/${path}`, async (c) => {
    const page = pageNumber(c.req.query("page"));
    const items = await getLibrary(c.env).listMedia(kind, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return c.html(mediaListPage(kind, items));
  });
}

app.get("/item/:id", async (c) => {
  const detail = await getLibrary(c.env).mediaDetail(Number(c.req.param("id")));
  if (!detail) return c.notFound();
  return c.html(mediaItemPage(detail));
});

// --- ratings / status (HTMX fragments) ---
const RATABLE: RatableKind[] = ["track", "album", "book", "media"];

app.post("/:kind/:id/rating", async (c) => {
  const kind = c.req.param("kind") as RatableKind;
  if (!RATABLE.includes(kind)) return c.notFound();
  const id = Number(c.req.param("id"));
  const value = Number((await c.req.parseBody()).value ?? c.req.query("value") ?? 0);
  const applied = await getLibrary(c.env).rate(kind, id, value);
  return c.html(stars(kind, id, applied));
});

app.post("/track/:id/favorite", async (c) => {
  const id = Number(c.req.param("id"));
  const on = await getLibrary(c.env).toggleFavorite(id);
  return c.html(favBtn(id, on));
});

app.post("/book/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const status = String((await c.req.parseBody()).status ?? "");
  if (!READING_STATUSES.includes(status as ReadingStatus)) return c.body(null, 400);
  await getLibrary(c.env).setReadingStatus(id, status as ReadingStatus);
  return c.body(null, 204);
});

// --- Admin: bulk import (legacy catalog migration; behind Cloudflare Access) ---
app.post("/admin/import", async (c) => {
  const lib = getLibrary(c.env);
  const payload = (await c.req.json()) as Parameters<typeof lib.importChunk>[0];
  const result = await lib.importChunk(payload);
  return c.json(result);
});

// Bulk import from a JSON dump stored in R2 (used for the legacy catalog
// migration): the data loads from object storage rather than a request body.
app.post("/admin/import-r2", async (c) => {
  const key = c.req.query("key") ?? "import/dump.json";
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.json({ error: `no R2 object at ${key}` }, 404);
  const lib = getLibrary(c.env);
  const payload = JSON.parse(await obj.text()) as Parameters<typeof lib.importChunk>[0];
  const result = await lib.importChunk(payload);
  return c.json(result);
});

app.post("/admin/enrich", async (c) => {
  const limit = Math.max(1, Math.min(25, Number(c.req.query("limit") ?? 5)));
  const processed = await getLibrary(c.env).drainEnrichment(limit);
  return c.json({ processed });
});

app.post("/admin/repair-artists", async (c) => {
  const limit = Math.max(1, Math.min(500, Number(c.req.query("limit") ?? 100)));
  return c.json(await getLibrary(c.env).repairCompoundArtists(limit));
});

// --- Telegram bot ---
// NOTE: exclude /telegram/webhook from Cloudflare Access — Telegram can't
// authenticate through it. The webhook is guarded by its own secret_token.
app.post("/telegram/webhook", (c) => handleWebhook(c.req.raw, c.env, c.executionCtx));

// One-time webhook registration (behind Cloudflare Access in prod).
app.get("/telegram/register", async (c) => {
  const url = new URL(c.req.url);
  const hook = `${url.origin}/telegram/webhook`;
  try {
    await registerWebhook(hook, c.env);
    return c.text(`Webhook registered: ${hook}`);
  } catch (e) {
    return c.text(`Failed: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
});

export default {
  fetch: app.fetch,
  scheduled(_event, env, ctx) {
    const lib = getLibrary(env);
    ctx.waitUntil(lib.drainEnrichment(20));
    ctx.waitUntil(runYouTubeMigrationBatch(env, YOUTUBE_MIGRATION_BATCH_SIZE));
    ctx.waitUntil(runYouTubeSourceSync(env));
  },
} satisfies ExportedHandler<Env>;
