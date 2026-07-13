import type { Classified } from "./types";

/**
 * Recognize a supported media URL and extract its source + canonical id.
 * Returns null for anything we don't handle.
 */
export function classify(rawUrl: string): Classified | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const path = url.pathname;

  // --- Spotify ---
  if (host === "open.spotify.com") {
    const m = path.match(/\/(track|album|artist|playlist)\/([A-Za-z0-9]+)/);
    if (m) return { provider: "spotify", itemKind: m[1] === "playlist" ? null : m[1] as NonNullable<Classified["itemKind"]>, providerId: m[2], url: canonical(url) };
    return null;
  }

  // --- YouTube (incl. YouTube Music) ---
  if (host === "youtu.be") {
    const id = path.slice(1);
    if (id) return { provider: "youtube", itemKind: "track", providerId: id, url: `https://www.youtube.com/watch?v=${id}` };
    return null;
  }
  if (host === "youtube.com" || host === "music.youtube.com" || host === "m.youtube.com") {
    const list = url.searchParams.get("list");
    const v = url.searchParams.get("v");
    if (path.startsWith("/playlist") && list) {
      return { provider: "youtube", itemKind: null, providerId: list, url: `https://www.youtube.com/playlist?list=${list}` };
    }
    if (v) return { provider: "youtube", itemKind: "track", providerId: v, url: `https://www.youtube.com/watch?v=${v}` };
    return null;
  }

  // --- Bandcamp (fetcher lands in M3) ---
  if (host.endsWith(".bandcamp.com")) {
    const m = path.match(/\/(track|album)\/([\w-]+)/);
    if (m) {
      const sourceId = `${host}${path}`;
      return { provider: "bandcamp", itemKind: m[1] as "track" | "album", providerId: sourceId, url: `https://${host}${path}` };
    }
    return null;
  }

  // --- Goodreads (fetcher lands in M3) ---
  if (host === "goodreads.com") {
    const m = path.match(/\/book\/show\/(\d+)/);
    if (m) return { provider: "goodreads", itemKind: "book", providerId: m[1], url: `https://www.goodreads.com/book/show/${m[1]}` };
    return null;
  }

  // --- MyAnimeList ---
  if (host === "myanimelist.net") {
    const m = path.match(/^\/(anime|manga)\/(\d+)(?:\/|$)/);
    if (m) return { provider: "myanimelist", itemKind: m[1] as "anime" | "manga", providerId: m[2], url: `https://myanimelist.net/${m[1]}/${m[2]}` };
    const legacy = path.match(/^\/(anime|manga)\.php$/);
    const id = url.searchParams.get("id");
    if (legacy && id && /^\d+$/.test(id)) {
      return { provider: "myanimelist", itemKind: legacy[1] as "anime" | "manga", providerId: id, url: `https://myanimelist.net/${legacy[1]}/${id}` };
    }
    return null;
  }

  // --- WEBTOON ---
  if (host === "webtoons.com") {
    const id = url.searchParams.get("title_no");
    if (id && /^\d+$/.test(id) && path.includes("/list")) {
      return { provider: "webtoon", itemKind: "webtoon", providerId: id, url: `${url.origin}${path}?title_no=${id}` };
    }
    return null;
  }

  return null;
}

/** Strip query/fragment, keep the clean entity URL. */
function canonical(url: URL): string {
  return `${url.origin}${url.pathname}`;
}
