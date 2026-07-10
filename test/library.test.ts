import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Smoke test: the DO boots, applies its schema, and serves counts.
describe("Library DO", () => {
  it("responds to ping", async () => {
    const lib = env.LIBRARY.get(env.LIBRARY.idFromName("test-1"));
    expect(await lib.ping()).toBe("pong");
  });

  it("starts empty with a valid schema", async () => {
    const lib = env.LIBRARY.get(env.LIBRARY.idFromName("test-2"));
    const stats = await lib.stats();
    expect(stats).toEqual({ tracks: 0, artists: 0, albums: 0, books: 0, links: 0, pending: 0 });
    expect(await lib.recent(5)).toEqual([]);
  });

  it("clamps ratings to 0..5", async () => {
    const lib = env.LIBRARY.get(env.LIBRARY.idFromName("test-3"));
    expect(await lib.rate("track", 1, 7)).toBe(5);
    expect(await lib.rate("book", 1, -3)).toBe(0);
    expect(await lib.rate("album", 1, 3)).toBe(3);
  });
});
