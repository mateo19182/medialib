import type { Env } from "../types";
import { getLibrary } from "../types";
import { normalize } from "../util";
import type { YouTubeMigrationTrack } from "../db/library";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const GOOGLE_PROVIDER = "google";
const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const DAILY_QUOTA_BUDGET = 9500;
const PLAYLIST_CREATE_UNITS = 50;
const TRACK_MIGRATION_UNITS = 100;

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface YouTubeSearchItem {
  id?: { videoId?: string };
  snippet?: { title?: string; channelTitle?: string };
}

export interface YouTubeBatchResult {
  processed: number;
  added: number;
  skipped: number;
  failed: number;
  message?: string;
}

export function googleRedirectUri(origin: string): string {
  return `${origin}/oauth/google/callback`;
}

export async function googleAuthorizationUrl(env: Env, origin: string, returnTo = "/migrate"): Promise<string> {
  requireGoogleOAuthConfig(env);
  const state = crypto.randomUUID();
  await getLibrary(env).createOAuthState(GOOGLE_PROVIDER, state, safeReturnTo(returnTo));
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", googleRedirectUri(origin));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", YOUTUBE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function handleGoogleOAuthCallback(env: Env, origin: string, code: string, state: string): Promise<string> {
  requireGoogleOAuthConfig(env);
  const lib = getLibrary(env);
  const oauthState = await lib.consumeOAuthState(GOOGLE_PROVIDER, state);
  if (!oauthState.valid) throw new Error("Invalid or expired OAuth state");
  const body = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: googleRedirectUri(origin),
  });
  const token = await postGoogleToken(body);
  if (!token.access_token) throw new Error("Google did not return an access token");
  await lib.saveOAuthToken(GOOGLE_PROVIDER, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresAt: Date.now() + Math.max(0, Number(token.expires_in ?? 3600) - 60) * 1000,
    scope: token.scope ?? YOUTUBE_SCOPE,
  });
  return safeReturnTo(oauthState.returnTo ?? "/migrate");
}

export async function runYouTubeMigrationBatch(env: Env, limit = 2): Promise<YouTubeBatchResult> {
  const lib = getLibrary(env);
  const status = await lib.youtubeMigrationStatus();
  if (status.status !== "running") return { processed: 0, added: 0, skipped: 0, failed: 0, message: "No migration is running." };
  requireYouTubeConfig(env);

  let accessToken = await validGoogleAccessToken(env);
  const today = youtubeQuotaDay();
  let playlistId = status.playlist_id;
  if (!playlistId) {
    if (!(await lib.reserveYoutubeQuota(PLAYLIST_CREATE_UNITS, today, DAILY_QUOTA_BUDGET))) {
      return { processed: 0, added: 0, skipped: 0, failed: 0, message: "Daily YouTube quota budget reached." };
    }
    playlistId = await createPlaylist(accessToken);
    await lib.setYoutubeMigrationPlaylist(playlistId);
  }

  const tracks = await lib.youtubePendingMigrationTracks(limit);
  if (!tracks.length) {
    await lib.noteYoutubeMigration("No pending tracks remain.");
    return { processed: 0, added: 0, skipped: 0, failed: 0, message: "No pending tracks remain." };
  }

  const result: YouTubeBatchResult = { processed: 0, added: 0, skipped: 0, failed: 0 };
  for (const track of tracks) {
    if (!(await lib.reserveYoutubeQuota(TRACK_MIGRATION_UNITS, today, DAILY_QUOTA_BUDGET))) {
      result.message = "Daily YouTube quota budget reached.";
      break;
    }
    try {
      const match = await searchBestVideo(env, track);
      if (!match) {
        await lib.markYoutubeMigrationItem(track.track_id, { status: "skipped", error: "No YouTube match found" });
        result.skipped++;
      } else {
        accessToken = await validGoogleAccessToken(env);
        await addVideoToPlaylist(accessToken, playlistId, match.videoId);
        await lib.markYoutubeMigrationItem(track.track_id, { status: "added", videoId: match.videoId, videoTitle: match.title });
        result.added++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientYouTubeError(message)) {
        await lib.markYoutubeMigrationItem(track.track_id, { status: "pending", error: message });
        result.message = "YouTube returned a transient error; this track will retry in a later batch.";
        break;
      }
      await lib.markYoutubeMigrationItem(track.track_id, { status: "error", error: message });
      result.failed++;
    }
    result.processed++;
  }
  return result;
}

export function scoreYouTubeMatch(track: Pick<YouTubeMigrationTrack, "title" | "artists">, candidateTitle: string, channelTitle = ""): number {
  const title = normalize(candidateTitle);
  const channel = normalize(channelTitle.replace(/\s+-\s+topic$/i, ""));
  const wantedTitle = normalize(track.title);
  const wantedArtists = splitArtistNames(track.artists).map(normalize).filter(Boolean);
  let score = 0;
  if (title === wantedTitle) score += 80;
  else if (title.includes(wantedTitle)) score += 45;
  for (const artist of wantedArtists) {
    if (!artist) continue;
    if (title.includes(artist)) score += 30;
    if (channel.includes(artist)) score += 25;
  }
  if (/\bofficial audio\b|\btopic\b|\bprovided to youtube\b/.test(title) || /\btopic\b/.test(channel)) score += 10;
  if (/\blive\b|\bremix\b|\bcover\b|\binstrumental\b|\bkaraoke\b/.test(title) && !wantedTitle.match(/\blive\b|\bremix\b|\binstrumental\b/)) score -= 20;
  return score;
}

async function searchBestVideo(env: Env, track: YouTubeMigrationTrack): Promise<{ videoId: string; title: string } | null> {
  if (!env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY is not configured");
  const url = new URL(`${YOUTUBE_API}/search`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("videoCategoryId", "10");
  url.searchParams.set("maxResults", "5");
  url.searchParams.set("q", track.query);
  url.searchParams.set("key", env.YOUTUBE_API_KEY);
  const data = await youtubeJson<{ items?: YouTubeSearchItem[] }>(url.toString());
  const candidates = (data.items ?? [])
    .map((item) => ({
      videoId: item.id?.videoId ?? "",
      title: item.snippet?.title ?? "",
      score: scoreYouTubeMatch(track, item.snippet?.title ?? "", item.snippet?.channelTitle ?? ""),
    }))
    .filter((item) => item.videoId && item.title)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best && best.score >= 30 ? { videoId: best.videoId, title: best.title } : null;
}

async function createPlaylist(accessToken: string): Promise<string> {
  const data = await youtubeJson<{ id?: string }>(`${YOUTUBE_API}/playlists?part=snippet,status`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      snippet: {
        title: `Spotify likes migration ${new Date().toISOString().slice(0, 10)}`,
        description: "Created by medialib from the saved Spotify likes catalog.",
      },
      status: { privacyStatus: "private" },
    }),
  });
  if (!data.id) throw new Error("YouTube did not return a playlist id");
  return data.id;
}

async function addVideoToPlaylist(accessToken: string, playlistId: string, videoId: string): Promise<void> {
  await youtubeJson(`${YOUTUBE_API}/playlistItems?part=snippet`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      snippet: {
        playlistId,
        resourceId: { kind: "youtube#video", videoId },
      },
    }),
  });
}

export async function validGoogleAccessToken(env: Env): Promise<string> {
  requireGoogleOAuthConfig(env);
  const lib = getLibrary(env);
  const token = await lib.getOAuthToken(GOOGLE_PROVIDER);
  if (!token) throw new Error("Google OAuth is not connected");
  if (token.expires_at > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) throw new Error("Google OAuth refresh token is missing; reconnect Google");
  const refreshed = await postGoogleToken(new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
  }));
  if (!refreshed.access_token) throw new Error("Google did not return a refreshed access token");
  await lib.saveOAuthToken(GOOGLE_PROVIDER, {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? null,
    expiresAt: Date.now() + Math.max(0, Number(refreshed.expires_in ?? 3600) - 60) * 1000,
    scope: refreshed.scope ?? token.scope,
  });
  return refreshed.access_token;
}

async function postGoogleToken(body: URLSearchParams): Promise<GoogleTokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = await response.json<GoogleTokenResponse>();
  if (!response.ok) throw new Error(token.error_description ?? token.error ?? `Google token exchange failed: ${response.status}`);
  return token;
}

export async function youtubeJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (response.ok) return response.json<T>();
  const text = await response.text();
  throw new Error(`YouTube API ${response.status}: ${text.slice(0, 300)}`);
}

export function authHeaders(accessToken: string): HeadersInit {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

function splitArtistNames(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function isTransientYouTubeError(message: string): boolean {
  return /\b(409|429|500|502|503|504)\b|SERVICE_UNAVAILABLE|quotaExceeded|rateLimitExceeded/i.test(message);
}

function youtubeQuotaDay(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function requireGoogleOAuthConfig(env: Env): asserts env is Env & { GOOGLE_OAUTH_CLIENT_ID: string; GOOGLE_OAUTH_CLIENT_SECRET: string } {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) throw new Error("Google OAuth client is not configured");
}

function requireYouTubeConfig(env: Env): void {
  requireGoogleOAuthConfig(env);
  if (!env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY is not configured");
}

function safeReturnTo(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/migrate";
}
