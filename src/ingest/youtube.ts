import type { Env } from "../types";
import type { Classified, Fetched, FetchedTrack } from "./types";
import { htmlDecode, iso8601ToMs } from "../util";

// Strip any (…) or […] group that contains a production/quality keyword,
// e.g. "(Official Video)", "(4K Remaster)", "[HD]". Keeps meaningful ones
// like "(Remix)" or "(Live)".
const NOISE =
  /\s*[([][^)\]]*\b(?:official|video|audio|lyrics?|visualizer|remaster(?:ed)?|explicit|hd|hq|4k|mv|full album|official music)\b[^)\]]*[)\]]/gi;

/** Pure: derive a track from a YouTube title + channel name. */
export function videoToTrack(
  rawTitle: string,
  channel: string | undefined,
  coverUrl?: string,
  durationMs?: number,
): FetchedTrack {
  const title = htmlDecode(rawTitle).replace(NOISE, "").trim();
  const chan = htmlDecode(channel ?? "").replace(/\s*-\s*Topic$/i, "").trim();

  // "Artist - Song" is the dominant convention; fall back to the channel name.
  const dash = title.match(/^(.*?)\s+[-–—]\s+(.*)$/);
  if (dash) {
    return { entityType: "track", title: dash[2].trim(), artist: dash[1].trim(), durationMs, coverUrl };
  }
  return { entityType: "track", title, artist: chan || "Unknown", durationMs, coverUrl };
}

interface YtVideoResponse {
  items?: { snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string }> }; contentDetails?: { duration?: string } }[];
}

async function fetchViaDataApi(id: string, key: string): Promise<Fetched | null> {
  const u = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${id}&key=${key}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`youtube data api -> ${r.status}`);
  const data = (await r.json()) as YtVideoResponse;
  const item = data.items?.[0];
  if (!item) return null;
  const thumbs = item.snippet?.thumbnails ?? {};
  const cover = (thumbs.maxres ?? thumbs.high ?? thumbs.medium ?? thumbs.default)?.url;
  return videoToTrack(
    item.snippet?.title ?? "",
    item.snippet?.channelTitle,
    cover,
    iso8601ToMs(item.contentDetails?.duration),
  );
}

interface YtOembed {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

async function fetchViaOembed(url: string): Promise<Fetched | null> {
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error(`youtube oembed -> ${r.status}`);
  const o = (await r.json()) as YtOembed;
  return videoToTrack(o.title ?? "", o.author_name, o.thumbnail_url);
}

export async function fetchYouTube(c: Classified, env: Env): Promise<Fetched | null> {
  if (c.kind !== "video") return null; // playlist expansion deferred
  // Prefer the official Data API (richer: real duration) when a key is configured.
  if (env.YOUTUBE_API_KEY) return fetchViaDataApi(c.sourceId, env.YOUTUBE_API_KEY);
  return fetchViaOembed(c.url);
}
