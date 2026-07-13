import { describe, it, expect } from "vitest";
import { classify } from "../src/ingest/classify";
import { parseSpotify } from "../src/ingest/spotify";
import { videoToTrack } from "../src/ingest/youtube";
import { parseBandcamp } from "../src/ingest/bandcamp";
import { parseGoodreads } from "../src/ingest/goodreads";
import { parseMyAnimeList } from "../src/ingest/myanimelist";
import { parseWebtoonPage, parseWebtoonSavedList } from "../src/ingest/webtoon";
import { splitArtists, normalize, iso8601ToMs } from "../src/util";

describe("classify", () => {
  it("recognizes Spotify entities", () => {
    expect(classify("https://open.spotify.com/track/0g1E4Q6653qeAegOEL5T1B?si=abc")).toMatchObject({
      provider: "spotify",
      itemKind: "track",
      providerId: "0g1E4Q6653qeAegOEL5T1B",
    });
    expect(classify("https://open.spotify.com/album/4XhHiKbo6yUr642e0GCrhK")?.itemKind).toBe("album");
    expect(classify("https://open.spotify.com/artist/6yJ6QQ3Y5l0s0tn7b0arrO")?.itemKind).toBe("artist");
  });

  it("normalizes YouTube variants to a video id", () => {
    const a = classify("https://youtu.be/dQw4w9WgXcQ");
    const b = classify("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123");
    const c = classify("https://music.youtube.com/watch?v=dQw4w9WgXcQ");
    for (const x of [a, b, c]) {
      expect(x?.provider).toBe("youtube");
      expect(x?.itemKind).toBe("track");
      expect(x?.providerId).toBe("dQw4w9WgXcQ");
    }
    expect(classify("https://www.youtube.com/playlist?list=PLxyz")?.itemKind).toBeNull();
  });

  it("recognizes Bandcamp and Goodreads", () => {
    expect(classify("https://artist.bandcamp.com/album/cool-record")).toMatchObject({ provider: "bandcamp", itemKind: "album" });
    expect(classify("https://www.goodreads.com/book/show/12345.The_Book")).toMatchObject({ provider: "goodreads", itemKind: "book", providerId: "12345" });
  });

  it("recognizes MyAnimeList anime and manga", () => {
    expect(classify("https://myanimelist.net/anime/5114/Fullmetal_Alchemist_Brotherhood")).toMatchObject({
      provider: "myanimelist",
      itemKind: "anime",
      providerId: "5114",
      url: "https://myanimelist.net/anime/5114",
    });
    expect(classify("https://myanimelist.net/manga.php?id=2")).toMatchObject({
      provider: "myanimelist",
      itemKind: "manga",
      providerId: "2",
      url: "https://myanimelist.net/manga/2",
    });
  });

  it("recognizes WEBTOON titles", () => {
    expect(classify("https://www.webtoons.com/en/drama/lookism/list?title_no=1049")).toMatchObject({
      provider: "webtoon",
      itemKind: "webtoon",
      providerId: "1049",
      url: "https://www.webtoons.com/en/drama/lookism/list?title_no=1049",
    });
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
      kind: "track",
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
      kind: "album",
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

describe("parseBandcamp", () => {
  it("parses an album from JSON-LD", () => {
    const node = {
      "@type": "MusicAlbum",
      name: "Minecraft - Volume Alpha",
      byArtist: "C418",
      datePublished: "04 Mar 2011 00:00:00 GMT",
      image: "https://f4.bcbits.com/img/a.jpg",
    };
    expect(parseBandcamp(node, {}, "album")).toEqual({
      kind: "album",
      title: "Minecraft - Volume Alpha",
      artist: "C418",
      year: 2011,
      coverUrl: "https://f4.bcbits.com/img/a.jpg",
    });
  });

  it("parses a track with byArtist/inAlbum objects", () => {
    const node = { "@type": "MusicRecording", name: "Sweden", byArtist: { name: "C418" }, inAlbum: { name: "Volume Alpha" } };
    expect(parseBandcamp(node, {}, "track")).toMatchObject({ kind: "track", title: "Sweden", artist: "C418", album: "Volume Alpha" });
  });

  it("falls back to og:title '…, by Artist' when JSON-LD is missing", () => {
    const og = { "og:title": "Cool Record, by Some Artist", "og:image": "https://x/i.jpg", "og:site_name": "Some Artist" };
    expect(parseBandcamp(null, og, "album")).toMatchObject({ title: "Cool Record", artist: "Some Artist" });
  });
});

describe("parseGoodreads", () => {
  it("parses a book, decoding entities", () => {
    const node = {
      "@type": "Book",
      name: "Atomic Habits: An Easy &amp; Proven Way",
      author: ["James Clear"],
      numberOfPages: 319,
      image: "https://m.media-amazon.com/x.jpg",
    };
    expect(parseGoodreads(node, { "og:description": "A book about habits." })).toEqual({
      kind: "book",
      title: "Atomic Habits: An Easy & Proven Way",
      author: "James Clear",
      isbn: undefined,
      year: undefined,
      pageCount: 319,
      description: "A book about habits.",
      coverUrl: "https://m.media-amazon.com/x.jpg",
    });
  });
});

describe("parseMyAnimeList", () => {
  it("parses anime metadata from og tags", () => {
    expect(
      parseMyAnimeList(
        null,
        {
          "og:title": "Fullmetal Alchemist: Brotherhood - MyAnimeList.net",
          "og:description": "Looking for information on the anime Fullmetal Alchemist: Brotherhood (2009)?",
          "og:image": "https://cdn.myanimelist.net/images/anime/1208/94745.jpg",
        },
        "anime",
      ),
    ).toEqual({
      kind: "anime",
      title: "Fullmetal Alchemist: Brotherhood",
      year: 2009,
      description: "Looking for information on the anime Fullmetal Alchemist: Brotherhood (2009)?",
      coverUrl: "https://cdn.myanimelist.net/images/anime/1208/94745.jpg",
    });
  });

  it("parses manga metadata from JSON-LD", () => {
    expect(
      parseMyAnimeList(
        {
          "@type": "Book",
          name: "Berserk",
          datePublished: "1989-08-25",
          image: { url: "https://cdn.myanimelist.net/images/manga/1/157897.jpg" },
        },
        {},
        "manga",
      ),
    ).toMatchObject({
      kind: "manga",
      title: "Berserk",
      year: 1989,
      coverUrl: "https://cdn.myanimelist.net/images/manga/1/157897.jpg",
    });
  });
});

describe("parseWebtoon", () => {
  it("parses saved-list HTML items", () => {
    expect(
      parseWebtoonSavedList(`
        <ul class="my_list _card_list">
          <li class="item">
            <a href="https://www.webtoons.com/en/drama/lookism/list?title_no=1049" class="link">
              <div class="image_wrap" data-title-unsuitable-for-children="true">
                <img src="https://webtoon.example/lookism.jpg?type=q90" alt="">
              </div>
              <div class="info">
                <p class="subj">Lookism</p>
                <p class="author">Taejun Pak</p>
                <span class="update">Jul 12, 2026 Updated</span>
              </div>
            </a>
            <input id="0" class="blind _inputCheck" data-title-no="1049" data-webtoon-type="WEBTOON">
          </li>
        </ul>
      `),
    ).toEqual([
      {
        url: "https://www.webtoons.com/en/drama/lookism/list?title_no=1049",
        titleNo: "1049",
        title: "Lookism",
        author: "Taejun Pak",
        coverUrl: "https://webtoon.example/lookism.jpg?type=q90",
        webtoonType: "WEBTOON",
        updateLabel: "Jul 12, 2026 Updated",
        unsuitableForChildren: true,
      },
    ]);
  });

  it("parses WEBTOON page metadata", () => {
    expect(parseWebtoonPage({ "og:title": "Lookism | WEBTOON", "og:description": "A series.", "og:image": "https://img.example/cover.jpg" })).toEqual({
      kind: "webtoon",
      title: "Lookism",
      description: "A series.",
      coverUrl: "https://img.example/cover.jpg",
    });
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
