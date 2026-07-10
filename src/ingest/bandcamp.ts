import type { Classified, Fetched } from "./types";
import { fetchText, jsonLd, ldFind, metaTags } from "./extract";
import { extractYear, htmlDecode } from "../util";

type LdNode = Record<string, unknown>;

/** byArtist / inAlbum can be a string, an object with `name`, or an array. */
function ldName(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return htmlDecode(v);
  if (Array.isArray(v)) return ldName(v[0]);
  if (typeof v === "object") return ldName((v as LdNode).name);
  return undefined;
}

function ldImage(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return ldImage(v[0]);
  if (typeof v === "object") return ldImage((v as LdNode).url ?? (v as LdNode).contentUrl);
  return undefined;
}

/** Pure: build a catalog entity from Bandcamp's JSON-LD + og fallback. */
export function parseBandcamp(node: LdNode | null, og: Record<string, string>, kind: Classified["kind"]): Fetched | null {
  const name = htmlDecode(String(node?.name ?? og["og:title"] ?? "")).replace(/,\s*by\s+.+$/i, "").trim();
  if (!name) return null;
  const artist = ldName(node?.byArtist) ?? (og["og:title"]?.match(/,\s*by\s+(.+)$/i)?.[1]) ?? og["og:site_name"] ?? "Unknown";
  const cover = ldImage(node?.image) ?? og["og:image"];
  const year = extractYear(String(node?.datePublished ?? ""));

  if (kind === "album") {
    return { entityType: "album", title: name, artist, year, coverUrl: cover };
  }
  const album = ldName(node?.inAlbum);
  return { entityType: "track", title: name, artist, album, year, coverUrl: cover };
}

export async function fetchBandcamp(c: Classified): Promise<Fetched | null> {
  const html = await fetchText(c.url);
  const node = ldFind(jsonLd(html), "MusicAlbum", "MusicRecording");
  return parseBandcamp(node, metaTags(html), c.kind);
}
