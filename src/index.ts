import { Hono } from "hono";
import type { Env } from "./types";
import { getLibrary } from "./types";
import { addPage, artistPage, booksPage, dashboard, libraryPage } from "./web/pages";
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
