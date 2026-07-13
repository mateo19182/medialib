import type { Env } from "../types";
import type { Classified, Fetched } from "./types";
import { fetchSpotify } from "./spotify";
import { fetchYouTube } from "./youtube";
import { fetchBandcamp } from "./bandcamp";
import { fetchGoodreads } from "./goodreads";
import { fetchMyAnimeList } from "./myanimelist";
import { fetchWebtoon } from "./webtoon";

export { classify } from "./classify";
export type { Classified, Fetched, ItemKind, Provider, VisualKind } from "./types";

/**
 * Fetch base metadata for a classified link. Returns null when the kind isn't
 * a catalog entity (e.g. playlists) or the source page cannot be interpreted;
 * the caller still records the raw link.
 */
export async function fetchMetadata(c: Classified, env: Env): Promise<Fetched | null> {
  switch (c.provider) {
    case "spotify":
      return fetchSpotify(c);
    case "youtube":
      return fetchYouTube(c, env);
    case "bandcamp":
      return fetchBandcamp(c);
    case "goodreads":
      return fetchGoodreads(c);
    case "myanimelist":
      return fetchMyAnimeList(c);
    case "webtoon":
      return fetchWebtoon(c);
    default:
      return null;
  }
}
