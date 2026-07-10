import { Hono } from "hono";
import type { Env } from "./types";
import { getLibrary } from "./types";
import { addPage, artistPage, bookPage, booksPage, dashboard, favBtn, libraryPage, stars } from "./web/pages";
import { READING_STATUSES, type RatableKind, type ReadingStatus } from "./do/library";
import { handleWebhook, registerWebhook } from "./bot/telegram";

// The Durable Object class must be exported from the Worker entrypoint.
export { Library } from "./do/library";

const app = new Hono<{ Bindings: Env }>();

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
  const lib = getLibrary(c.env);
  const [stats, recent] = await Promise.all([lib.stats(), lib.recent(20)]);
  return c.html(dashboard(stats, recent));
});

app.get("/library", async (c) => {
  const artists = await getLibrary(c.env).listArtists();
  return c.html(libraryPage(artists));
});

app.get("/artist/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const detail = await getLibrary(c.env).artistDetail(id);
  if (!detail) return c.notFound();
  return c.html(artistPage(detail));
});

app.get("/add", (c) => c.html(addPage()));

app.post("/add", async (c) => {
  const body = await c.req.parseBody();
  const url = String(body.url ?? "").trim();
  const result = await getLibrary(c.env).saveLink(url, "web");
  return c.html(addPage(result));
});

app.get("/books", async (c) => {
  const books = await getLibrary(c.env).listBooks();
  return c.html(booksPage(books));
});

app.get("/book/:id", async (c) => {
  const detail = await getLibrary(c.env).bookDetail(Number(c.req.param("id")));
  if (!detail) return c.notFound();
  return c.html(bookPage(detail));
});

// --- ratings / status (HTMX fragments) ---
const RATABLE: RatableKind[] = ["track", "album", "book"];

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

export default app;
