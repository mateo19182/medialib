import { Hono } from "hono";
import type { Env } from "./types";
import { getLibrary } from "./types";
import { addPage, artistPage, dashboard, libraryPage } from "./web/pages";
import { handleWebhook, registerWebhook } from "./bot/telegram";

// The Durable Object class must be exported from the Worker entrypoint.
export { Library } from "./do/library";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

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

// Books arrive with Goodreads in M3.
app.get("/books", (c) => c.text("books — coming in M3", 501));

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
