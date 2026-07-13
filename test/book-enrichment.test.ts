import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichBook } from "../src/enrich/openlibrary";
import { resolveText } from "../src/ingest/text";

afterEach(() => vi.unstubAllGlobals());

describe("Open Library book matching", () => {
  it("rejects a longer, unrelated title for a text-added book", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ docs: [
      { key: "/works/OL3540645W", title: "The Anything Box", author_name: ["Zenna Henderson"], cover_i: 7147974 },
    ] }))));

    await expect(resolveText("book", "The Anything Book")).resolves.toBeNull();
  });

  it("uses an exact title and prefers its ISBN-13", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ docs: [
      { key: "/works/OL1W", title: "Exact Book", author_name: ["A. Writer"], isbn: ["123456789X", "9781234567897"], cover_i: 42 },
    ] }))));

    await expect(resolveText("book", "Exact Book")).resolves.toMatchObject({
      providerId: "OL1W",
      fetched: { title: "Exact Book", isbn: "9781234567897", coverUrl: "https://covers.openlibrary.org/b/id/42-L.jpg" },
    });
  });

  it("returns an ISBN discovered during enrichment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ docs: [
      { key: "/works/OL2W", title: "Enriched Book", isbn: ["0123456789", "9780123456786"] },
    ] }))));

    await expect(enrichBook({ title: "Enriched Book", author: "A. Writer" })).resolves.toMatchObject({
      olid: "OL2W", isbn: "9780123456786",
    });
  });

  it("uses an ISBN-bearing edition and its cover when the work result has neither", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ docs: [
        { key: "/works/OL3540645W", title: "The Anything Box", author_name: ["Zenna Henderson"], cover_i: 7147974 },
      ] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [
        { key: "/books/OL1M", isbn_10: ["0586028218"], covers: [15115824] },
        { key: "/books/OL7431465M", isbn_13: ["9780380017454"], covers: [15115618] },
      ] }))));

    await expect(resolveText("book", "The Anything Box")).resolves.toMatchObject({
      providerId: "OL3540645W",
      fetched: {
        isbn: "9780380017454",
        coverUrl: "https://covers.openlibrary.org/b/id/15115618-L.jpg",
      },
    });
  });
});
