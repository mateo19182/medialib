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
    if (m) return { source: "spotify", kind: m[1] as Classified["kind"], sourceId: m[2], url: canonical(url) };
    return null;
  }

  // --- YouTube (incl. YouTube Music) ---
  if (host === "youtu.be") {
    const id = path.slice(1);
    if (id) return { source: "youtube", kind: "video", sourceId: id, url: `https://www.youtube.com/watch?v=${id}` };
    return null;
  }
  if (host === "youtube.com" || host === "music.youtube.com" || host === "m.youtube.com") {
    const list = url.searchParams.get("list");
    const v = url.searchParams.get("v");
    if (path.startsWith("/playlist") && list) {
      return { source: "youtube", kind: "playlist", sourceId: list, url: `https://www.youtube.com/playlist?list=${list}` };
    }
    if (v) return { source: "youtube", kind: "video", sourceId: v, url: `https://www.youtube.com/watch?v=${v}` };
    return null;
  }

  // --- Bandcamp (fetcher lands in M3) ---
  if (host.endsWith(".bandcamp.com")) {
    const m = path.match(/\/(track|album)\/([\w-]+)/);
    if (m) {
      const sourceId = `${host}${path}`;
      return { source: "bandcamp", kind: m[1] as Classified["kind"], sourceId, url: `https://${host}${path}` };
    }
    return null;
  }

  // --- Goodreads (fetcher lands in M3) ---
  if (host === "goodreads.com") {
    const m = path.match(/\/book\/show\/(\d+)/);
    if (m) return { source: "goodreads", kind: "book", sourceId: m[1], url: `https://www.goodreads.com/book/show/${m[1]}` };
    return null;
  }

  return null;
}

/** Strip query/fragment, keep the clean entity URL. */
function canonical(url: URL): string {
  return `${url.origin}${url.pathname}`;
}
