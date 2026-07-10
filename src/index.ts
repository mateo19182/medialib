import { Hono } from "hono";
import type { Env } from "./types";
import { getLibrary } from "./types";
import { addPage, artistPage, dashboard, libraryPage } from "./web/pages";

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

export default app;
