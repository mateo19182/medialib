/**
 * MusicBrainz lookups for canonical IDs + genres, and Cover Art Archive URLs.
 * MusicBrainz asks for a descriptive User-Agent and ~1 req/s; scheduled
 * enrichment keeps batches small.
 */
const MB = "https://musicbrainz.org/ws/2";
const UA = "medialib/0.1 (https://github.com/mateo19182/medialib)";

async function mb(path: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${MB}/${path}&fmt=json`, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error(`musicbrainz ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

function tagString(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  const names = tags
    .filter((t) => t && typeof t === "object")
    .sort((a, b) => Number((b as { count?: number }).count ?? 0) - Number((a as { count?: number }).count ?? 0))
    .map((t) => String((t as { name?: string }).name ?? ""))
    .filter(Boolean)
    .slice(0, 4);
  return names.length ? names.join(", ") : null;
}

const q = (s: string) => encodeURIComponent(s.replace(/["\\]/g, " "));

export async function enrichArtist(name: string): Promise<{ mbid: string; genres: string | null } | null> {
  const d = await mb(`artist?query=artist:"${q(name)}"&limit=1`);
  const a = (d.artists as Record<string, unknown>[] | undefined)?.[0];
  if (!a) return null;
  return { mbid: String(a.id), genres: tagString(a.tags) };
}

export async function enrichRelease(
  title: string,
  artist: string,
): Promise<{ mbid: string; year?: number } | null> {
  const d = await mb(`release?query=release:"${q(title)}" AND artist:"${q(artist)}"&limit=1`);
  const r = (d.releases as Record<string, unknown>[] | undefined)?.[0];
  if (!r) return null;
  const date = typeof r.date === "string" ? r.date : "";
  const year = date ? Number(date.slice(0, 4)) : undefined;
  return { mbid: String(r.id), year: Number.isFinite(year) ? year : undefined };
}

export async function enrichRecording(
  title: string,
  artist: string,
): Promise<{ mbid: string; isrc?: string } | null> {
  const d = await mb(`recording?query=recording:"${q(title)}" AND artist:"${q(artist)}"&limit=1`);
  const r = (d.recordings as Record<string, unknown>[] | undefined)?.[0];
  if (!r) return null;
  const isrc = Array.isArray(r.isrcs) ? String(r.isrcs[0] ?? "") : "";
  return { mbid: String(r.id), isrc: isrc || undefined };
}

export function coverArtUrl(releaseMbid: string): string {
  return `https://coverartarchive.org/release/${releaseMbid}/front-500`;
}
