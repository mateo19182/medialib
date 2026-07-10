/** Text normalization + HTML helpers shared across ingestion. */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/** Decode the HTML entities that show up in og:/JSON-LD metadata. */
export function htmlDecode(s: string): string {
  if (!s) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

/** Canonical form for dedupe/matching: lowercase, de-accented, punctuation-stripped. */
export function normalize(s: string): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface ParsedArtist {
  name: string;
  role: "main" | "featured";
}

const FEAT_SPLIT = /\s+(?:feat\.?|featuring|ft\.?|with)\s+/i;
const MAIN_SPLIT = /\s*(?:,|&|;|\/)\s*|\s+(?:x|vs\.?)\s+/i;

/**
 * Split a compound artist string ("A, B feat. C") into individual artists with
 * main/featured roles. Mirrors the old app's disaggregation behavior.
 */
export function splitArtists(raw: string): ParsedArtist[] {
  if (!raw) return [];
  const [mainPart, featPart] = raw.split(FEAT_SPLIT);
  const out: ParsedArtist[] = [];
  const seen = new Set<string>();
  const push = (name: string, role: "main" | "featured") => {
    const n = htmlDecode(name).trim();
    const key = normalize(n);
    if (!n || seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, role });
  };
  for (const n of mainPart.split(MAIN_SPLIT)) push(n, "main");
  if (featPart) for (const n of featPart.split(MAIN_SPLIT)) push(n, "featured");
  return out.length ? out : [{ name: htmlDecode(raw).trim(), role: "main" }];
}

/** Parse an ISO-8601 duration (e.g. "PT3M2S") into milliseconds. */
export function iso8601ToMs(d: string | null | undefined): number | undefined {
  if (!d) return undefined;
  const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return undefined;
  const [, h, min, s] = m;
  const ms = ((Number(h) || 0) * 3600 + (Number(min) || 0) * 60 + (Number(s) || 0)) * 1000;
  return ms || undefined;
}

/** First 4-digit year found in a string. */
export function extractYear(s: string | null | undefined): number | undefined {
  const m = (s ?? "").match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : undefined;
}
