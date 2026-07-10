import { describe, it, expect } from "vitest";
import { classify } from "../src/ingest/classify";
import { parseSpotify } from "../src/ingest/spotify";
import { videoToTrack } from "../src/ingest/youtube";
import { splitArtists, normalize, iso8601ToMs } from "../src/util";

describe("classify", () => {
  it("recognizes Spotify entities", () => {
    expect(classify("https://open.spotify.com/track/0g1E4Q6653qeAegOEL5T1B?si=abc")).toMatchObject({
      source: "spotify",
      kind: "track",
      sourceId: "0g1E4Q6653qeAegOEL5T1B",
    });
    expect(classify("https://open.spotify.com/album/4XhHiKbo6yUr642e0GCrhK")?.kind).toBe("album");
    expect(classify("https://open.spotify.com/artist/6yJ6QQ3Y5l0s0tn7b0arrO")?.kind).toBe("artist");
  });

  it("normalizes YouTube variants to a video id", () => {
    const a = classify("https://youtu.be/dQw4w9WgXcQ");
    const b = classify("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123");
    const c = classify("https://music.youtube.com/watch?v=dQw4w9WgXcQ");
    for (const x of [a, b, c]) {
      expect(x?.source).toBe("youtube");
      expect(x?.kind).toBe("video");
      expect(x?.sourceId).toBe("dQw4w9WgXcQ");
    }
    expect(classify("https://www.youtube.com/playlist?list=PLxyz")?.kind).toBe("playlist");
  });

  it("recognizes Bandcamp and Goodreads", () => {
    expect(classify("https://artist.bandcamp.com/album/cool-record")).toMatchObject({ source: "bandcamp", kind: "album" });
    expect(classify("https://www.goodreads.com/book/show/12345.The_Book")).toMatchObject({ source: "goodreads", kind: "book", sourceId: "12345" });
  });

  it("rejects unknown urls", () => {
    expect(classify("https://example.com/foo")).toBeNull();
    expect(classify("not a url")).toBeNull();
  });
});

describe("parseSpotify", () => {
  it("parses a track's og metadata", () => {
    const meta = {
      "og:title": "PROTECT THE CROSS",
      "og:description": "JPEGMAFIA · PROTECT THE CROSS · Song · 2025",
      "og:image": "https://i.scdn.co/image/x",
      "music:duration": "169",
    };
    expect(parseSpotify(meta, "track")).toEqual({
      entityType: "track",
      title: "PROTECT THE CROSS",
      artist: "JPEGMAFIA",
      year: 2025,
      durationMs: 169000,
      coverUrl: "https://i.scdn.co/image/x",
    });
  });

  it("cleans album title suffix and decodes entities", () => {
    const meta = {
      "og:title": "Luke Vibert&#x27;s Nuggets 3 - Album by Luke Vibert | Spotify",
      "og:description": "Luke Vibert · album · 2013 · 26 songs",
      "og:image": "https://i.scdn.co/image/y",
    };
    expect(parseSpotify(meta, "album")).toEqual({
      entityType: "album",
      title: "Luke Vibert's Nuggets 3",
      artist: "Luke Vibert",
      year: 2013,
      coverUrl: "https://i.scdn.co/image/y",
    });
  });
});

describe("videoToTrack", () => {
  it("splits 'Artist - Title' and strips noise", () => {
    expect(videoToTrack("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", "Rick Astley")).toMatchObject({
      artist: "Rick Astley",
      title: "Never Gonna Give You Up",
    });
  });

  it("falls back to channel, stripping ' - Topic'", () => {
    expect(videoToTrack("Some Song", "Some Artist - Topic")).toMatchObject({ artist: "Some Artist", title: "Some Song" });
  });
});

describe("util", () => {
  it("splits compound artists with roles", () => {
    expect(splitArtists("03 Greedo, Kenny Beats feat. Vince Staples")).toEqual([
      { name: "03 Greedo", role: "main" },
      { name: "Kenny Beats", role: "main" },
      { name: "Vince Staples", role: "featured" },
    ]);
  });

  it("normalizes for matching", () => {
    expect(normalize("Björk!  (Deluxe)")).toBe("bjork deluxe");
  });

  it("parses ISO-8601 durations", () => {
    expect(iso8601ToMs("PT3M2S")).toBe(182000);
    expect(iso8601ToMs("PT1H1M")).toBe(3660000);
  });
});
