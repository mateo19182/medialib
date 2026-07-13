import type { Classified, Fetched } from "./types";
import { fetchText, metaTags } from "./extract";
import { extractYear, htmlDecode } from "../util";

/** Strip Spotify's title suffixes ("… - Album by X | Spotify", "… | Spotify"). */
function cleanTitle(title: string): string {
  return htmlDecode(title)
    .replace(/\s*[-–]\s*(?:Album|Single|EP|Song|Playlist)\s+by\s+.*$/i, "")
    .replace(/\s*\|\s*Spotify\s*$/i, "")
    .trim();
}

/**
 * Pure: turn Spotify's og:/music: metadata into a catalog entity.
 * og:description formats observed:
 *   track:  "Artist · Title · Song · 2025"
 *   album:  "Artist · album · 2013 · 26 songs"
 *   artist: "Artist · 1.8M monthly listeners."
 */
export function parseSpotify(meta: Record<string, string>, kind: "artist" | "album" | "track"): Fetched | null {
  const title = cleanTitle(meta["og:title"] ?? "");
  const desc = meta["og:description"] ?? "";
  const cover = meta["og:image"] || undefined;
  const parts = desc.split("·").map((s) => s.trim()).filter(Boolean);
  const artist = parts[0] || "Unknown"; // first segment is the artist for tracks & albums
  const year = extractYear(desc);

  switch (kind) {
    case "artist":
      return { kind: "artist", name: title || "Unknown", imageUrl: cover };
    case "album":
      return { kind: "album", title: title || "Unknown", artist: artist || "Unknown", year, coverUrl: cover };
    case "track": {
      const durSec = Number(meta["music:duration"]);
      return {
        kind: "track",
        title: title || "Unknown",
        artist: artist || "Unknown",
        year,
        durationMs: Number.isFinite(durSec) && durSec > 0 ? durSec * 1000 : undefined,
        coverUrl: cover,
      };
    }
  }
}

export async function fetchSpotify(c: Classified): Promise<Fetched | null> {
  if (c.itemKind !== "artist" && c.itemKind !== "album" && c.itemKind !== "track") return null;
  const html = await fetchText(c.url);
  return parseSpotify(metaTags(html), c.itemKind);
}
