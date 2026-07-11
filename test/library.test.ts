import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getLibrary } from "../src/types";

// Smoke test: the D1-backed library boots and serves counts.
describe("Library DB", () => {
  it("responds to ping", async () => {
    const lib = getLibrary(env);
    expect(await lib.ping()).toBe("pong");
  });

  it("starts empty with a valid schema", async () => {
    const lib = getLibrary(env);
    const stats = await lib.stats();
    expect(stats).toEqual({ tracks: 0, artists: 0, albums: 0, books: 0, movies: 0, series: 0, anime: 0, manga: 0, links: 0, pending: 0 });
    expect(await lib.recent(5)).toEqual([]);
  });

  it("clamps ratings to 0..5", async () => {
    const lib = getLibrary(env);
    expect(await lib.rate("track", 1, 7)).toBe(5);
    expect(await lib.rate("book", 1, -3)).toBe(0);
    expect(await lib.rate("album", 1, 3)).toBe(3);
  });

  it("shows collaboration tracks on every artist profile", async () => {
    const lib = getLibrary(env);
    await lib.importChunk({
      artists: [
        { id: 1001, name: "Alpha Artist", normalized_name: "alpha artist" },
        { id: 1002, name: "Beta Artist", normalized_name: "beta artist" },
      ],
      albums: [{ id: 2001, title: "Shared Album", normalized_title: "shared album", artist_id: 1001 }],
      tracks: [{ id: 3001, title: "Shared Track", normalized_title: "shared track", artist_id: 1001, album_id: 2001 }],
      trackArtists: [
        { track_id: 3001, artist_id: 1001, position: 0, role: "main" },
        { track_id: 3001, artist_id: 1002, position: 1, role: "main" },
      ],
    });

    const artists = await lib.listArtists();
    expect(artists.items.find((a) => a.id === 1001)).toMatchObject({ tracks: 1, albums: 1 });
    expect(artists.items.find((a) => a.id === 1002)).toMatchObject({ tracks: 1, albums: 0 });

    const beta = await lib.artistDetail(1002);
    expect(beta?.tracks.map((t) => t.title)).toContain("Shared Track");
    expect((await lib.listTracks()).items.find((t) => t.id === 3001)?.artists).toBe("Alpha Artist, Beta Artist");
  });

  it("splits compound legacy artist rows during import", async () => {
    const lib = getLibrary(env);
    await lib.importChunk({
      artists: [
        { id: 1201, name: "Split Legacy Alpha, Split Legacy Beta", normalized_name: "split legacy alpha split legacy beta" },
        { id: 1202, name: "Split Legacy Beta", normalized_name: "split legacy beta" },
      ],
      albums: [{ id: 2201, title: "Legacy Split Album", normalized_title: "legacy split album", artist_id: 1201 }],
      tracks: [{ id: 3201, title: "Legacy Split Track", normalized_title: "legacy split track", artist_id: 1201, album_id: 2201 }],
    });

    const artists = await lib.listArtists(1000, 0);
    expect(artists.items.some((a) => a.name === "Split Legacy Alpha, Split Legacy Beta")).toBe(false);
    expect(artists.items.find((a) => a.name === "Split Legacy Alpha")).toMatchObject({ tracks: 1, albums: 1 });
    expect(artists.items.find((a) => a.name === "Split Legacy Beta")).toMatchObject({ tracks: 1, albums: 0 });

    expect((await lib.listTracks(1000, 0)).items.find((t) => t.id === 3201)?.artists).toBe("Split Legacy Alpha, Split Legacy Beta");
    expect((await lib.search("Legacy Split Track", 10)).find((hit) => hit.href === "/track/3201")?.sub).toBe("Split Legacy Alpha, Split Legacy Beta");
  });

  it("repairs already-imported compound artist rows", async () => {
    const lib = getLibrary(env);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO artists (id, name, normalized_name) VALUES (1301, 'Repair Alpha, Repair Beta', 'repair alpha repair beta')"),
      env.DB.prepare("INSERT INTO albums (id, title, normalized_title, artist_id) VALUES (2301, 'Repair Album', 'repair album', 1301)"),
      env.DB.prepare("INSERT INTO tracks (id, title, normalized_title, artist_id, album_id) VALUES (3301, 'Repair Track', 'repair track', 1301, 2301)"),
      env.DB.prepare("INSERT INTO enrich_queue (entity_type, entity_id) VALUES ('artist', 1301)"),
    ]);

    expect(await lib.repairCompoundArtists(50)).toMatchObject({ repaired: 1, failed: 0 });

    const artists = await lib.listArtists(1000, 0);
    expect(artists.items.some((a) => a.name === "Repair Alpha, Repair Beta")).toBe(false);
    expect(artists.items.find((a) => a.name === "Repair Alpha")).toMatchObject({ tracks: 1, albums: 1 });
    expect(artists.items.find((a) => a.name === "Repair Beta")).toMatchObject({ tracks: 1, albums: 0 });
    expect((await lib.listTracks(1000, 0)).items.find((t) => t.id === 3301)?.artists).toBe("Repair Alpha, Repair Beta");
    expect(await env.DB.prepare("SELECT id FROM enrich_queue WHERE entity_id = 1301").first()).toBeNull();
  });

  it("stores non-musician artists without music enrichment", async () => {
    const lib = getLibrary(env);
    const saved = await lib.saveText("artist", "Non Music Creator", "web", "", "visual_artist");
    expect(saved).toMatchObject({ ok: true, entityType: "artist", title: "Non Music Creator" });

    const hit = (await lib.search("Non Music Creator", 10)).find((item) => item.name === "Non Music Creator");
    if (!hit) throw new Error("missing non-musician artist search hit");
    expect(hit).toMatchObject({ type: "artist", sub: "visual artist" });
    const detail = await lib.artistDetail(hit.id);
    expect(detail?.artist).toMatchObject({ name: "Non Music Creator", artist_type: "visual_artist" });
    expect(await env.DB.prepare("SELECT id FROM enrich_queue WHERE entity_type = 'artist' AND entity_id = ?").bind(hit.id).first()).toBeNull();

    const musicArtists = await lib.listArtists(1000, 0);
    expect(musicArtists.items.some((artist) => artist.name === "Non Music Creator")).toBe(false);
  });

  it("paginates catalog lists with a total count", async () => {
    const lib = getLibrary(env);
    const before = await lib.listArtists(1, 0);
    await lib.importChunk({
      artists: [
        { id: 1101, name: "First Artist", normalized_name: "first artist" },
        { id: 1102, name: "Second Artist", normalized_name: "second artist" },
      ],
      tracks: [
        { id: 3101, title: "First Track", normalized_title: "first track", artist_id: 1101 },
        { id: 3102, title: "Second Track", normalized_title: "second track", artist_id: 1102 },
      ],
    });
    const first = await lib.listArtists(1, 0);
    const second = await lib.listArtists(1, 1);

    expect(first).toMatchObject({ total: before.total + 2, limit: 1, offset: 0 });
    expect(first.items).toHaveLength(1);
    expect(second).toMatchObject({ total: before.total + 2, limit: 1, offset: 1 });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  it("searches visual media and returns page links", async () => {
    const lib = getLibrary(env);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO media_items (id, kind, title, normalized_title, year) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(4001, "anime", "Spirited Away", "spirited away", 2001)
      .run();

    const hits = await lib.search("spirited", 10);
    expect(hits).toContainEqual(expect.objectContaining({ type: "media", name: "Spirited Away", href: "/item/4001", sub: "anime · 2001" }));
  });

  it("records provider-owned IDs separately from local catalog IDs", async () => {
    const lib = getLibrary(env);
    await lib.importChunk({
      artists: [{ id: 5001, name: "Identifier Artist", normalized_name: "identifier artist", mbid: "7e5b4b73-0014-4c04-8b3f-9a1cc7b0a001" }],
    });

    const row = await env.DB.prepare(
      "SELECT entity_type, provider, external_id, is_primary FROM external_ids WHERE entity_type = 'artist' AND entity_id = 5001",
    ).first<{ entity_type: string; provider: string; external_id: string; is_primary: number }>();
    expect(row).toEqual({ entity_type: "artist", provider: "musicbrainz", external_id: "7e5b4b73-0014-4c04-8b3f-9a1cc7b0a001", is_primary: 1 });
  });

  it("deletes a media item and all dependent catalog data", async () => {
    const lib = getLibrary(env);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO media_items (id, kind, title, normalized_title, cover_key) VALUES (6001, 'movie', 'Delete Me', 'delete me', 'media/6001')"),
      env.DB.prepare("INSERT INTO links (url, source, source_kind, source_id, entity_type, entity_id) VALUES ('https://example.com/delete', 'manual', 'movie', 'delete-me', 'movie', 6001)"),
      env.DB.prepare("INSERT INTO external_ids (entity_type, entity_id, provider, external_id) VALUES ('movie', 6001, 'tmdb', '6001')"),
      env.DB.prepare("INSERT INTO enrich_queue (entity_type, entity_id) VALUES ('media', 6001)"),
    ]);
    await env.MEDIA.put("media/6001", "image");

    await lib.deleteEntry("media", 6001);

    expect(await env.DB.prepare("SELECT id FROM media_items WHERE id = 6001").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM links WHERE entity_id = 6001").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM external_ids WHERE entity_id = 6001").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM enrich_queue WHERE entity_id = 6001").first()).toBeNull();
    expect(await env.MEDIA.get("media/6001")).toBeNull();
  });
});
