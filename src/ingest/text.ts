import type { Fetched, MediaKind } from "./types";

export type TextAddKind = "artist" | "album" | "track" | "book" | MediaKind;
export const TEXT_ADD_KINDS: readonly TextAddKind[] = ["artist", "album", "track", "book", "movie", "series", "anime", "manga"];

export function isTextAddKind(value: unknown): value is TextAddKind {
  return typeof value === "string" && TEXT_ADD_KINDS.includes(value as TextAddKind);
}

export interface TextResolution {
  fetched: Fetched;
  source: string;
  sourceId: string;
  url: string;
}

const year = (value: unknown): number | undefined => {
  const match = String(value ?? "").match(/^\d{4}/);
  return match ? Number(match[0]) : undefined;
};

const image = (item: Record<string, unknown>): string | undefined => {
  const images = item.images as { jpg?: { large_image_url?: string; image_url?: string } } | undefined;
  return images?.jpg?.large_image_url ?? images?.jpg?.image_url;
};

async function deezer(kind: "artist" | "album" | "track", query: string): Promise<TextResolution | null> {
  const r = await fetch(`https://api.deezer.com/search/${kind}?q=${encodeURIComponent(query)}&limit=1`);
  if (!r.ok) throw new Error(`deezer ${r.status}`);
  const item = ((await r.json()) as { data?: Record<string, unknown>[] }).data?.[0];
  if (!item?.id) return null;
  const id = String(item.id);
  if (kind === "artist") {
    const name = String(item.name ?? "").trim();
    return name ? { fetched: { entityType: "artist", name, imageUrl: String(item.picture_xl ?? item.picture_big ?? "") || undefined }, source: "deezer", sourceId: id, url: `https://www.deezer.com/artist/${id}` } : null;
  }
  const artist = item.artist as Record<string, unknown> | undefined;
  const artistName = String(artist?.name ?? "Unknown");
  if (kind === "album") {
    const title = String(item.title ?? "").trim();
    return title ? { fetched: { entityType: "album", title, artist: artistName, year: year(item.release_date), coverUrl: String(item.cover_xl ?? item.cover_big ?? "") || undefined }, source: "deezer", sourceId: id, url: `https://www.deezer.com/album/${id}` } : null;
  }
  const album = item.album as Record<string, unknown> | undefined;
  const title = String(item.title ?? "").trim();
  return title ? { fetched: { entityType: "track", title, artist: artistName, album: typeof album?.title === "string" ? album.title : undefined, durationMs: Number(item.duration) ? Number(item.duration) * 1000 : undefined, coverUrl: String(album?.cover_xl ?? album?.cover_big ?? "") || undefined }, source: "deezer", sourceId: id, url: `https://www.deezer.com/track/${id}` } : null;
}

async function openLibrary(query: string, author?: string): Promise<TextResolution | null> {
  const params = new URLSearchParams({ title: query, limit: "1" });
  if (author) params.set("author", author);
  const r = await fetch(`https://openlibrary.org/search.json?${params}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`openlibrary ${r.status}`);
  const item = ((await r.json()) as { docs?: Record<string, unknown>[] }).docs?.[0];
  if (!item?.key || !item.title) return null;
  const olid = String(item.key).split("/").pop() ?? String(item.key);
  const isbn = Array.isArray(item.isbn) ? String(item.isbn[0] ?? "") || undefined : undefined;
  const itemAuthor = Array.isArray(item.author_name) ? String(item.author_name[0] ?? "Unknown") : "Unknown";
  return { fetched: { entityType: "book", title: String(item.title), author: itemAuthor, isbn, year: Number.isFinite(Number(item.first_publish_year)) ? Number(item.first_publish_year) : undefined, pageCount: Number.isFinite(Number(item.number_of_pages_median)) ? Number(item.number_of_pages_median) : undefined, coverUrl: item.cover_i ? `https://covers.openlibrary.org/b/id/${item.cover_i}-L.jpg` : undefined }, source: "openlibrary", sourceId: olid, url: `https://openlibrary.org/works/${olid}` };
}

async function jikan(kind: "anime" | "manga", query: string): Promise<TextResolution | null> {
  const r = await fetch(`https://api.jikan.moe/v4/${kind}?q=${encodeURIComponent(query)}&limit=1`);
  if (!r.ok) throw new Error(`jikan ${r.status}`);
  const item = ((await r.json()) as { data?: Record<string, unknown>[] }).data?.[0];
  if (!item?.mal_id || !item.title) return null;
  const id = String(item.mal_id);
  const dates = (kind === "anime" ? item.aired : item.published) as { from?: string } | undefined;
  return { fetched: { entityType: "media", kind, title: String(item.title), year: year(dates?.from), description: typeof item.synopsis === "string" ? item.synopsis : undefined, coverUrl: image(item) }, source: "myanimelist", sourceId: id, url: typeof item.url === "string" ? item.url : `https://myanimelist.net/${kind}/${id}` };
}

async function tmdb(kind: "movie" | "series", query: string, token?: string): Promise<TextResolution | null> {
  if (!token) return null;
  const type = kind === "movie" ? "movie" : "tv";
  const r = await fetch(`https://api.themoviedb.org/3/search/${type}?${new URLSearchParams({ query, include_adult: "false", language: "en-US" })}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (!r.ok) throw new Error(`tmdb ${r.status}`);
  const item = ((await r.json()) as { results?: Record<string, unknown>[] }).results?.[0];
  const title = String(item?.title ?? item?.name ?? "").trim();
  if (!item?.id || !title) return null;
  const id = String(item.id);
  const poster = typeof item.poster_path === "string" ? `https://image.tmdb.org/t/p/w780${item.poster_path}` : undefined;
  return { fetched: { entityType: "media", kind, title, year: year(item.release_date ?? item.first_air_date), description: typeof item.overview === "string" ? item.overview : undefined, coverUrl: poster }, source: "tmdb", sourceId: id, url: `https://www.themoviedb.org/${type}/${id}` };
}

/** Resolve a human-entered name to the best catalog match for its chosen type. */
export async function resolveText(kind: TextAddKind, query: string, tmdbToken?: string, creator?: string): Promise<TextResolution | null> {
  switch (kind) {
    case "artist": return deezer(kind, query);
    case "album": case "track": return deezer(kind, creator ? `${query} ${creator}` : query);
    case "book": return openLibrary(query, creator);
    case "anime": case "manga": return jikan(kind, query);
    case "movie": case "series": return tmdb(kind, query, tmdbToken);
  }
}
