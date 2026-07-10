import { Hono } from "hono";
import type { Env } from "./types";
import { getLibrary } from "./types";
import { dashboard } from "./web/pages";

// The Durable Object class must be exported from the Worker entrypoint.
export { Library } from "./do/library";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/", async (c) => {
  const lib = getLibrary(c.env);
  const [stats, recent] = await Promise.all([lib.stats(), lib.recent(20)]);
  return c.html(dashboard(stats, recent));
});

// Placeholders wired up in later milestones (M1+).
app.get("/library", (c) => c.text("music library — coming in M1", 501));
app.get("/books", (c) => c.text("books — coming in M1", 501));
app.get("/add", (c) => c.text("add-by-link form — coming in M1", 501));

export default app;
