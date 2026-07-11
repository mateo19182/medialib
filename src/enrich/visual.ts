import type { MediaKind } from "../ingest/types";

export interface ImageMatch {
  provider: string;
  id: string;
  url?: string;
  imageUrl?: string;
  year?: number;
  description?: string;
}

const year = (value: unknown): number | undefined => {
  const match = String(value ?? "").match(/^\d{4}/);
  return match ? Number(match[0]) : undefined;
};

/** Public Deezer search supplies stable artwork without embedding a client secret. */
export async function findDeezerArtist(name: string): Promise<ImageMatch | null> {
  const r = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=1`);
  if (!r.ok) throw new Error(`deezer artist ${r.status}`);
  const item = ((await r.json()) as { data?: Record<string, unknown>[] }).data?.[0];
  if (!item?.id) return null;
  return { provider: "deezer-artist", id: String(item.id), imageUrl: String(item.picture_xl ?? item.picture_big ?? "") || undefined };
}

export async function findDeezerAlbum(title: string, artist: string): Promise<ImageMatch | null> {
  const query = `${title} ${artist}`.trim();
  const r = await fetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(query)}&limit=1`);
  if (!r.ok) throw new Error(`deezer album ${r.status}`);
  const item = ((await r.json()) as { data?: Record<string, unknown>[] }).data?.[0];
  if (!item?.id) return null;
  return { provider: "deezer-album", id: String(item.id), imageUrl: String(item.cover_xl ?? item.cover_big ?? "") || undefined, year: year(item.release_date) };
}

/** Jikan is a public MAL API and gives imported MAL rows a cover without scraping pages. */
export async function findJikanMedia(kind: "anime" | "manga", malId: string): Promise<ImageMatch | null> {
  const r = await fetch(`https://api.jikan.moe/v4/${kind}/${encodeURIComponent(malId)}/full`);
  if (!r.ok) throw new Error(`jikan ${r.status}`);
  const data = (await r.json()) as { data?: Record<string, unknown> };
  const item = data.data;
  if (!item?.mal_id) return null;
  const images = item.images as { jpg?: { large_image_url?: string; image_url?: string } } | undefined;
  const aired = item.aired as { from?: string } | undefined;
  const published = item.published as { from?: string } | undefined;
  return {
    provider: `myanimelist:${kind}`,
    id: String(item.mal_id),
    url: typeof item.url === "string" ? item.url : undefined,
    imageUrl: images?.jpg?.large_image_url ?? images?.jpg?.image_url,
    year: year(aired?.from ?? published?.from),
    description: typeof item.synopsis === "string" ? item.synopsis : undefined,
  };
}

/** TMDB is the canonical source for films and series. It needs a read token. */
export async function findTmdbMedia(kind: "movie" | "series", title: string, releaseYear: number | null, token?: string): Promise<ImageMatch | null> {
  if (!token) return null;
  const type = kind === "movie" ? "movie" : "tv";
  const params = new URLSearchParams({ query: title, include_adult: "false", language: "en-US" });
  if (releaseYear) params.set(kind === "movie" ? "year" : "first_air_date_year", String(releaseYear));
  const r = await fetch(`https://api.themoviedb.org/3/search/${type}?${params}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (!r.ok) throw new Error(`tmdb ${r.status}`);
  const item = ((await r.json()) as { results?: Record<string, unknown>[] }).results?.[0];
  if (!item?.id) return null;
  const path = typeof item.poster_path === "string" ? item.poster_path : "";
  return {
    provider: "tmdb",
    id: String(item.id),
    url: `https://www.themoviedb.org/${type}/${item.id}`,
    imageUrl: path ? `https://image.tmdb.org/t/p/w780${path}` : undefined,
    year: year(item.release_date ?? item.first_air_date),
    description: typeof item.overview === "string" ? item.overview : undefined,
  };
}

export function isVisualKind(kind: MediaKind): kind is "movie" | "series" | "anime" | "manga" {
  return kind === "movie" || kind === "series" || kind === "anime" || kind === "manga";
}
