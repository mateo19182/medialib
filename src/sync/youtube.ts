import type { Env } from "../types";
import { getLibrary } from "../types";
import type { YouTubeSyncPlaylist } from "../db/library";
import { YOUTUBE_API, authHeaders, validGoogleAccessToken, youtubeJson } from "../migrate/youtube";

interface YouTubePlaylistResponse {
  items?: {
    id?: string;
    snippet?: {
      title?: string;
      channelTitle?: string;
      videoOwnerChannelTitle?: string;
      position?: number;
      resourceId?: { videoId?: string };
      thumbnails?: Record<string, { url?: string }>;
    };
  }[];
  nextPageToken?: string;
}

interface YouTubePlaylistDetailsResponse {
  items?: {
    snippet?: { title?: string };
  }[];
}

export interface YouTubeSourceSyncResult {
  playlists: number;
  pages: number;
  seen: number;
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
  message?: string;
}

export function youtubePlaylistIdFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const id = url.searchParams.get("list");
    return id?.trim() || null;
  } catch {
    return trimmed;
  }
}

export async function fetchYouTubePlaylistTitle(env: Env, playlistId: string): Promise<string | null> {
  const accessToken = await validGoogleAccessToken(env);
  const url = new URL(`${YOUTUBE_API}/playlists`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("id", playlistId);
  url.searchParams.set("maxResults", "1");
  const data = await youtubeJson<YouTubePlaylistDetailsResponse>(url.toString(), { headers: authHeaders(accessToken) });
  return data.items?.[0]?.snippet?.title?.trim() || null;
}

export async function runYouTubeSourceSync(env: Env, options: { playlistDbId?: number } = {}): Promise<YouTubeSourceSyncResult> {
  const lib = getLibrary(env);
  const playlists = await lib.enabledYoutubeSyncPlaylists(options.playlistDbId);
  const total: YouTubeSourceSyncResult = { playlists: playlists.length, pages: 0, seen: 0, imported: 0, duplicates: 0, skipped: 0, failed: 0 };

  if (!playlists.length) {
    total.message = "No enabled YouTube playlists are configured.";
    return total;
  }

  const runId = await lib.startYoutubeSyncRun(playlists.length);

  for (const playlist of playlists) {
    const result = await syncPlaylist(env, playlist).catch((error) => ({
      pages: 0,
      seen: 0,
      imported: 0,
      duplicates: 0,
      skipped: 0,
      failed: 1,
      error: error instanceof Error ? error.message : String(error),
    }));
    total.pages += result.pages;
    total.seen += result.seen;
    total.imported += result.imported;
    total.duplicates += result.duplicates;
    total.skipped += result.skipped;
    total.failed += result.failed;
    await lib.noteYoutubeSyncPlaylist(playlist.id, { ok: !result.error, error: result.error ?? null });
    await lib.noteYoutubeSyncRun(runId, {
      playlists_done: 1,
      pages_fetched: result.pages,
      items_seen: result.seen,
      imported: result.imported,
      duplicates: result.duplicates,
      skipped: result.skipped,
      failed: result.failed,
      message: result.error ? `${playlist.title}: ${result.error}` : `${playlist.title}: synced ${result.imported} new item${result.imported === 1 ? "" : "s"}`,
    });
  }

  total.message = `Synced ${total.playlists} playlist${total.playlists === 1 ? "" : "s"}; imported ${total.imported} new item${total.imported === 1 ? "" : "s"}.`;
  await lib.noteYoutubeSyncRun(runId, { message: total.message, done: true });
  return total;
}

async function syncPlaylist(env: Env, playlist: YouTubeSyncPlaylist): Promise<YouTubeSourceSyncResult & { error?: string }> {
  const lib = getLibrary(env);
  const accessToken = await validGoogleAccessToken(env);
  const result: YouTubeSourceSyncResult = { playlists: 1, pages: 0, seen: 0, imported: 0, duplicates: 0, skipped: 0, failed: 0 };
  let pageToken = "";
  let knownStreak = 0;

  for (let page = 0; page < playlist.scan_limit; page++) {
    const url = new URL(`${YOUTUBE_API}/playlistItems`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("playlistId", playlist.playlist_id);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const data = await youtubeJson<YouTubePlaylistResponse>(url.toString(), { headers: authHeaders(accessToken) });
    result.pages++;
    const items = data.items ?? [];
    const existing = await lib.existingYoutubeSyncPlaylistItems(playlist.playlist_id, items.map((item) => item.id ?? ""));

    for (const item of items) {
      result.seen++;
      const playlistItemId = item.id ?? "";
      if (playlistItemId && existing.has(playlistItemId)) {
        knownStreak++;
        if (knownStreak >= playlist.stop_after_known) return result;
        continue;
      }
      knownStreak = 0;
      const snippet = item.snippet;
      const videoId = snippet?.resourceId?.videoId;
      if (!playlistItemId || !videoId || !snippet?.title) {
        result.skipped++;
        continue;
      }
      const thumbs = snippet.thumbnails ?? {};
      const thumbnailUrl = (thumbs.maxres ?? thumbs.high ?? thumbs.medium ?? thumbs.default)?.url;
      const saved = await lib.saveSyncedYouTubeVideo({
        videoId,
        title: snippet.title,
        channelTitle: snippet.videoOwnerChannelTitle ?? snippet.channelTitle,
        thumbnailUrl,
        playlistId: playlist.playlist_id,
        playlistItemId,
        position: snippet.position ?? null,
        rawJson: item,
      });
      if (saved.duplicate) result.duplicates++;
      else result.imported++;
    }

    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }

  return result;
}
