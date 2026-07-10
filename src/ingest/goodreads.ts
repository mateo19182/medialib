import type { Classified, FetchedBook } from "./types";
import { fetchText, jsonLd, ldFind, metaTags } from "./extract";
import { extractYear, htmlDecode } from "../util";

type LdNode = Record<string, unknown>;

/** Goodreads' author is an array of strings or {name} objects. */
function ldAuthors(v: unknown): string | undefined {
  const one = (x: unknown): string | undefined =>
    typeof x === "string" ? htmlDecode(x) : x && typeof x === "object" ? ldAuthors((x as LdNode).name) : undefined;
  if (Array.isArray(v)) return v.map(one).filter(Boolean).join(", ") || undefined;
  return one(v);
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Pure: build a book from Goodreads' JSON-LD Book node + og fallback. */
export function parseGoodreads(node: LdNode | null, og: Record<string, string>): FetchedBook | null {
  const title = htmlDecode(String(node?.name ?? og["og:title"] ?? "")).trim();
  if (!title) return null;
  const image = node?.image;
  const cover = typeof image === "string" ? image : og["og:image"];
  return {
    entityType: "book",
    title,
    author: ldAuthors(node?.author) ?? "Unknown",
    isbn: typeof node?.isbn === "string" ? node.isbn : undefined,
    year: extractYear(String(node?.datePublished ?? "")),
    pageCount: num(node?.numberOfPages),
    description: og["og:description"] || undefined,
    coverUrl: cover,
  };
}

export async function fetchGoodreads(c: Classified): Promise<FetchedBook | null> {
  const html = await fetchText(c.url);
  const node = ldFind(jsonLd(html), "Book");
  return parseGoodreads(node, metaTags(html));
}
