import type { Env } from "../types";
import type { Classified, Fetched } from "./types";
import { fetchSpotify } from "./spotify";
import { fetchYouTube } from "./youtube";
import { fetchBandcamp } from "./bandcamp";
import { fetchGoodreads } from "./goodreads";

export { classify } from "./classify";
export type { Classified, Fetched, EntityType, Source, SourceKind } from "./types";

/**
 * Fetch base metadata for a classified link. Returns null when the source has
 * no fetcher yet (Bandcamp/Goodreads arrive in M3) or the kind isn't a catalog
 * entity (e.g. playlists in M1) — the caller still records the raw link.
 */
export async function fetchMetadata(c: Classified, env: Env): Promise<Fetched | null> {
  switch (c.source) {
    case "spotify":
      return fetchSpotify(c);
    case "youtube":
      return fetchYouTube(c, env);
    case "bandcamp":
      return fetchBandcamp(c);
    case "goodreads":
      return fetchGoodreads(c);
    default:
      return null;
  }
}
