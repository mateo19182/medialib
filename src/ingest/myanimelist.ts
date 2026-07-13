import type { Classified, FetchedVisual } from "./types";
import { fetchText, jsonLd, ldFind, metaTags } from "./extract";
import { extractYear, htmlDecode } from "../util";

type LdNode = Record<string, unknown>;

function cleanTitle(raw: string): string {
  return htmlDecode(raw)
    .replace(/\s*-\s*MyAnimeList\.net\s*$/i, "")
    .replace(/\s*\|\s*MAL\s*$/i, "")
    .trim();
}

function ldImage(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return ldImage(v[0]);
  if (typeof v === "object") return ldImage((v as LdNode).url ?? (v as LdNode).contentUrl);
  return undefined;
}

/** Pure: build an anime/manga media item from MyAnimeList metadata. */
export function parseMyAnimeList(node: LdNode | null, og: Record<string, string>, kind: "anime" | "manga"): FetchedVisual | null {
  const rawTitle = String(node?.name ?? og["og:title"] ?? "");
  const title = cleanTitle(rawTitle);
  if (!title) return null;
  const rawDescription = String(node?.description ?? og["og:description"] ?? "").trim();
  const description = rawDescription ? htmlDecode(rawDescription) : undefined;
  const cover = ldImage(node?.image) ?? og["og:image"];
  const date = String(node?.datePublished ?? node?.startDate ?? "");
  return {
    kind,
    title,
    year: extractYear(date || description),
    description,
    coverUrl: cover,
  };
}

export async function fetchMyAnimeList(c: Classified): Promise<FetchedVisual | null> {
  if (c.itemKind !== "anime" && c.itemKind !== "manga") return null;
  const html = await fetchText(c.url);
  const node = ldFind(jsonLd(html), "TVSeries", "Movie", "Book");
  return parseMyAnimeList(node, metaTags(html), c.itemKind);
}
