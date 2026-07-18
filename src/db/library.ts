import type { Env, LibraryStats } from "../types";
import { classify, fetchMetadata } from "../ingest";
import type { Fetched } from "../ingest";
import type { ArtistType, Classified, FetchedBook, FetchedVisual, ItemKind, Provider, VisualKind } from "../ingest/types";
import { normalize, splitArtists } from "../util";
import * as mb from "../enrich/musicbrainz";
import { enrichBook } from "../enrich/openlibrary";
import { findDeezerAlbum, findDeezerArtist, findJikanMedia, findTmdbMedia, isVisualKind } from "../enrich/visual";
import { cacheImage } from "../r2";
import { isTextAddKind, resolveText, type TextAddKind } from "../ingest/text";
import type { LiveShow } from "../live-shows";
import { videoToTrack } from "../ingest/youtube";

export type TelegramAddMode = TextAddKind | "live";

const MAX_ATTEMPTS = 3;

const splitLines = (value?: string) => (value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
const splitComma = (value?: string) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const parseStringList = (value: unknown): string[] => {
  try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
};
const ARTIST_TYPE_SET = new Set<ArtistType>(["musician", "visual_artist", "filmmaker", "writer", "performer", "other"]);
const artistType = (value: unknown): ArtistType => ARTIST_TYPE_SET.has(value as ArtistType) ? value as ArtistType : "musician";
const youtubeMusicPlaylistUrl = (playlistId: string) => `https://music.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;

export interface SaveResult {
  ok: boolean;
  duplicate?: boolean;
  linkId?: number;
  status?: string;
  itemKind?: ItemKind | null;
  title?: string;
  error?: string;
}

export interface CompoundArtistRepairResult {
  processed: number;
  repaired: number;
  skipped: number;
  failed: number;
}

export interface ArtistSummary {
  id: number;
  name: string;
  artist_type: ArtistType;
  image_url: string | null;
  image_key: string | null;
  albums: number;
  tracks: number;
}

export interface RecentLink {
  id: number;
  url: string;
  provider: string;
  item_kind: ItemKind | null;
  title: string | null;
  status: string;
  saved_at: string;
  saved_via: string;
}

export interface AlbumRow {
  id: number;
  title: string;
  year: number | null;
  cover_url: string | null;
  cover_key: string | null;
  rating: number | null;
  artist_id: number | null;
  artist: string | null;
  tracks: number;
}

export interface TrackRow {
  id: number;
  title: string;
  duration_ms: number | null;
  album: string | null;
  album_id: number | null;
  artist_id: number | null;
  artist: string | null;
  artists: string | null;
  rating: number | null;
  favorite: number;
}

export interface TrackArtistRow {
  id: number;
  name: string;
  role: string;
}

export interface AlbumDetail {
  album: AlbumRow;
  tracks: TrackRow[];
}

export interface TrackDetail {
  track: TrackRow;
  artists: TrackArtistRow[];
}

export interface SearchResult {
  type: string;
  id: number;
  name: string;
  sub: string;
  href: string;
}

export interface BookDetail {
  id: number;
  title: string;
  author: string | null;
  cover_url: string | null;
  cover_key: string | null;
  year: number | null;
  publisher: string | null;
  page_count: number | null;
  isbn: string | null;
  description: string | null;
  reading_status: string | null;
  rating: number | null;
}

export type RatableKind = "track" | "album" | "book" | "media";
export const READING_STATUSES = ["want", "reading", "read"] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export interface ArtistDetail {
  artist: { id: number; name: string; artist_type: ArtistType; image_url: string | null; image_key: string | null; genres: string | null };
  albums: AlbumRow[];
  tracks: TrackRow[];
}

export interface BookRow {
  id: number;
  title: string;
  author: string | null;
  cover_url: string | null;
  cover_key: string | null;
  year: number | null;
  reading_status: string | null;
}

export interface MediaRow {
  id: number;
  kind: VisualKind;
  title: string;
  cover_url: string | null;
  cover_key: string | null;
  year: number | null;
  rating: number | null;
  media_format: string | null;
  list_status: string | null;
  progress_current: number | null;
  progress_total: number | null;
  personal_score: number | null;
}

export interface MediaDetail extends MediaRow {
  provider: string | null;
  provider_url: string | null;
  description: string | null;
  notes: string | null;
  tags: string | null;
}

export interface LiveShowInput {
  artist: string;
  date?: string;
  dateLabel?: string;
  venue?: string;
  city?: string;
  context?: string;
  companions?: string;
  summary?: string;
  notes?: string;
  tags?: string;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Whitelisted ORDER BY clauses per list; unknown keys fall back to the first entry. */
const ARTIST_SORTS: Record<string, string> = {
  name: "a.name COLLATE NOCASE",
  tracks: "tracks DESC, a.name COLLATE NOCASE",
  albums: "albums DESC, a.name COLLATE NOCASE",
  recent: "a.id DESC",
};
const ALBUM_SORTS: Record<string, string> = {
  title: "al.title COLLATE NOCASE",
  year: "al.year IS NULL, al.year DESC, al.title COLLATE NOCASE",
  rating: "al.rating IS NULL, al.rating DESC, al.title COLLATE NOCASE",
  recent: "al.id DESC",
};
const TRACK_SORTS: Record<string, string> = {
  title: "t.title COLLATE NOCASE",
  artist: "artists COLLATE NOCASE, t.title COLLATE NOCASE",
  rating: "t.rating IS NULL, t.rating DESC, t.title COLLATE NOCASE",
  recent: "t.id DESC",
};
const BOOK_SORTS: Record<string, string> = {
  title: "b.title COLLATE NOCASE",
  author: "author IS NULL, author COLLATE NOCASE, b.title COLLATE NOCASE",
  year: "b.year IS NULL, b.year DESC, b.title COLLATE NOCASE",
  rating: "b.rating IS NULL, b.rating DESC, b.title COLLATE NOCASE",
  recent: "b.id DESC",
};
const MEDIA_SORTS: Record<string, string> = {
  title: "title COLLATE NOCASE",
  year: "year IS NULL, year DESC, title COLLATE NOCASE",
  rating: "rating IS NULL, rating DESC, title COLLATE NOCASE",
  score: "personal_score IS NULL, personal_score DESC, title COLLATE NOCASE",
  recent: "created_at DESC, id DESC",
};
const pickSort = (sorts: Record<string, string>, key: string | undefined): string =>
  sorts[key ?? ""] ?? Object.values(sorts)[0];

/** list_status values that count as "finished" for the unwatched/unread filter. */
const DONE_STATUSES = ["completed", "watched", "read", "finished", "dropped"];

export interface OAuthTokenRow {
  provider: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  scope: string | null;
}

export interface YouTubeMigrationStatus {
  status: string;
  playlist_id: string | null;
  playlist_url: string | null;
  items_total: number;
  items_done: number;
  added: number;
  skipped: number;
  failed: number;
  pending: number;
  quota_day: string | null;
  quota_used: number;
  message: string | null;
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
}

export interface YouTubeMigrationTrack {
  track_id: number;
  query: string;
  title: string;
  artists: string;
}

export interface OAuthState {
  valid: boolean;
  returnTo: string | null;
}

export interface YouTubeSyncPlaylist {
  id: number;
  playlist_id: string;
  title: string;
  url: string;
  enabled: number;
  scan_limit: number;
  stop_after_known: number;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface YouTubeSyncRun {
  id: number;
  status: string;
  mode: string;
  playlists_total: number;
  playlists_done: number;
  pages_fetched: number;
  items_seen: number;
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
  message: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface SyncedYouTubeVideo {
  videoId: string;
  title: string;
  channelTitle?: string;
  thumbnailUrl?: string;
  playlistId: string;
  playlistItemId: string;
  position?: number | null;
  rawJson?: unknown;
}

type SaveVia = "web" | "telegram" | "linkwarden" | "youtube-sync";

type SqlValue = string | number | null;
type ImportArtist = { id: number; name: string; normalized_name: string; artist_type?: ArtistType | null; mbid?: string | null; image_url?: string | null; genres?: string | null };
type ImportAlbum = { id: number; title: string; normalized_title: string; artist_id?: number | null; mbid?: string | null; cover_url?: string | null; year?: number | null };
type ImportTrack = { id: number; title: string; normalized_title: string; artist_id?: number | null; album_id?: number | null; duration_ms?: number | null; isrc?: string | null; mbid?: string | null };
type ImportTrackArtist = { track_id: number; artist_id: number; position?: number; role?: string };
type ImportPayload = {
  reset?: boolean;
  artists?: ImportArtist[];
  albums?: ImportAlbum[];
  tracks?: ImportTrack[];
  trackArtists?: ImportTrackArtist[];
};

/**
 * D1-backed catalog service. Schema changes live in migrations; request
 * handlers construct this lightweight wrapper per request.
 */
export class LibraryDb {
  constructor(private readonly env: Env) {}

  private stmt(sql: string, args: SqlValue[] = []): D1PreparedStatement {
    return this.env.DB.prepare(sql).bind(...args);
  }

  private async all<T>(sql: string, args: SqlValue[] = []): Promise<T[]> {
    const result = await this.stmt(sql, args).all<T>();
    return (result.results ?? []) as T[];
  }

  private async first<T>(sql: string, args: SqlValue[] = []): Promise<T | null> {
    return (await this.stmt(sql, args).first<T>()) ?? null;
  }

  private async scalar(sql: string, args: SqlValue[] = []): Promise<unknown> {
    const row = await this.first<{ value: unknown }>(sql, args);
    return row?.value;
  }

  private run(sql: string, args: SqlValue[] = []): Promise<D1Result> {
    return this.stmt(sql, args).run();
  }

  private async page<T>(sql: string, countSql: string, args: SqlValue[], limit: number, offset: number): Promise<PageResult<T>> {
    const size = Math.max(1, Math.min(100, Math.floor(limit)));
    const start = Math.max(0, Math.floor(offset));
    const [rows, count] = await this.env.DB.batch([
      this.stmt(`${sql} LIMIT ? OFFSET ?`, [...args, size, start]),
      this.stmt(countSql, args),
    ]);
    return {
      items: (rows.results ?? []) as T[],
      total: Number((count.results?.[0] as { value?: unknown } | undefined)?.value ?? 0),
      limit: size,
      offset: start,
    };
  }

  ping(): string {
    return "pong";
  }

  async stats(): Promise<LibraryStats> {
    const row = await this.first<LibraryStats>(`SELECT
      (SELECT COUNT(*) FROM tracks) AS tracks,
      (SELECT COUNT(*) FROM artists) AS artists,
      (SELECT COUNT(*) FROM albums) AS albums,
      (SELECT COUNT(*) FROM books) AS books,
      (SELECT COUNT(*) FROM media_items WHERE kind = 'movie') AS movies,
      (SELECT COUNT(*) FROM media_items WHERE kind = 'series') AS series,
      (SELECT COUNT(*) FROM media_items WHERE kind = 'anime') AS anime,
      (SELECT COUNT(*) FROM media_items WHERE kind = 'manga') AS manga,
      (SELECT COUNT(*) FROM media_items WHERE kind = 'webtoon') AS webtoons,
      (SELECT COUNT(*) FROM media_items WHERE kind = 'comic') AS comics,
      (SELECT COUNT(*) FROM item_sources WHERE saved_at IS NOT NULL) AS links,
      (SELECT COUNT(*) FROM enrich_queue) AS pending`);
    return row ?? { tracks: 0, artists: 0, albums: 0, books: 0, movies: 0, series: 0, anime: 0, manga: 0, webtoons: 0, comics: 0, links: 0, pending: 0 };
  }

  recent(limit = 20): Promise<RecentLink[]> {
    return this.all<RecentLink>(
      `SELECT id, url, provider, item_kind, title, status, saved_at, saved_via
       FROM item_sources WHERE saved_at IS NOT NULL ORDER BY saved_at DESC, id DESC LIMIT ?`,
      [limit],
    );
  }

  // --- OAuth + YouTube Music migration ------------------------------------

  async createOAuthState(provider: string, state: string, returnTo = "/migrate"): Promise<void> {
    await this.run(
      "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
      [`oauth_state:${provider}:${state}`, JSON.stringify({ createdAt: Date.now(), returnTo })],
    );
  }

  async consumeOAuthState(provider: string, state: string): Promise<OAuthState> {
    const key = `oauth_state:${provider}:${state}`;
    const row = await this.first<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key]);
    await this.run("DELETE FROM kv WHERE key = ?", [key]);
    if (!row) return { valid: false, returnTo: null };
    let created = Number(row.value);
    let returnTo: string | null = null;
    if (!Number.isFinite(created)) {
      try {
        const parsed = JSON.parse(row.value) as { createdAt?: unknown; returnTo?: unknown };
        created = Number(parsed.createdAt);
        returnTo = typeof parsed.returnTo === "string" ? parsed.returnTo : null;
      } catch {
        created = NaN;
      }
    }
    return { valid: Number.isFinite(created) && Date.now() - created < 30 * 60 * 1000, returnTo };
  }

  getOAuthToken(provider: string): Promise<OAuthTokenRow | null> {
    return this.first<OAuthTokenRow>(
      "SELECT provider, access_token, refresh_token, expires_at, scope FROM oauth_tokens WHERE provider = ?",
      [provider],
    );
  }

  async saveOAuthToken(
    provider: string,
    token: { accessToken: string; refreshToken?: string | null; expiresAt: number; scope?: string | null },
  ): Promise<void> {
    await this.run(
      `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, scope, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(provider) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
         expires_at = excluded.expires_at,
         scope = COALESCE(excluded.scope, oauth_tokens.scope),
         updated_at = datetime('now')`,
      [provider, token.accessToken, token.refreshToken ?? null, token.expiresAt, token.scope ?? null],
    );
  }

  async youtubeMigrationStatus(): Promise<YouTubeMigrationStatus> {
    const row = await this.first<Omit<YouTubeMigrationStatus, "pending">>(
      `SELECT status, playlist_id, playlist_url, items_total, items_done, added, skipped, failed,
              quota_day, quota_used, message, started_at, updated_at, finished_at
       FROM youtube_migration WHERE id = 1`,
    );
    if (!row) {
      const tracks = Number(await this.scalar("SELECT COUNT(*) AS value FROM tracks"));
      return {
        status: "idle",
        playlist_id: null,
        playlist_url: null,
        items_total: tracks,
        items_done: 0,
        added: 0,
        skipped: 0,
        failed: 0,
        pending: tracks,
        quota_day: null,
        quota_used: 0,
        message: null,
        started_at: null,
        updated_at: null,
        finished_at: null,
      };
    }
    return { ...row, pending: Math.max(0, Number(row.items_total) - Number(row.items_done)) };
  }

  async startYoutubeMigration(reset = false): Promise<YouTubeMigrationStatus> {
    if (reset) {
      await this.env.DB.batch([
        this.stmt("DELETE FROM youtube_migration_items"),
        this.stmt("DELETE FROM youtube_migration WHERE id = 1"),
      ]);
    }
    await this.run(
      `INSERT OR IGNORE INTO youtube_migration (id, status, started_at, updated_at)
       VALUES (1, 'running', datetime('now'), datetime('now'))`,
    );
    await this.run(
      `WITH track_rows AS (
         SELECT t.id AS track_id,
                t.title,
                COALESCE(
                  (SELECT group_concat(name, ', ')
                   FROM (
                     SELECT ar.name
                     FROM track_artists ta
                     JOIN artists ar ON ar.id = ta.artist_id
                     WHERE ta.track_id = t.id
                     ORDER BY ta.position, ar.name COLLATE NOCASE
                   )),
                  a.name,
                  'Unknown artist'
                ) AS artists
         FROM tracks t
         LEFT JOIN artists a ON a.id = t.artist_id
       )
       INSERT OR IGNORE INTO youtube_migration_items (track_id, status, query, title, artists)
       SELECT track_id, 'pending', artists || ' - ' || title, title, artists
       FROM track_rows
       ORDER BY track_id`,
    );
    await this.run(
      `UPDATE youtube_migration
       SET status = CASE WHEN (SELECT COUNT(*) FROM youtube_migration_items WHERE status NOT IN ('added', 'skipped', 'error')) = 0 THEN 'done' ELSE 'running' END,
           started_at = COALESCE(started_at, datetime('now')),
           finished_at = CASE WHEN (SELECT COUNT(*) FROM youtube_migration_items WHERE status NOT IN ('added', 'skipped', 'error')) = 0 THEN COALESCE(finished_at, datetime('now')) ELSE NULL END,
           message = 'Migration queued',
           updated_at = datetime('now')
       WHERE id = 1`,
    );
    await this.refreshYoutubeMigrationCounts();
    return this.youtubeMigrationStatus();
  }

  async youtubePendingMigrationTracks(limit = 5): Promise<YouTubeMigrationTrack[]> {
    return this.all<YouTubeMigrationTrack>(
      `SELECT track_id, query, title, artists
       FROM youtube_migration_items
       WHERE status = 'pending'
       ORDER BY track_id
       LIMIT ?`,
      [Math.max(1, Math.min(25, Math.floor(limit)))],
    );
  }

  async setYoutubeMigrationPlaylist(playlistId: string): Promise<void> {
    await this.run(
      `UPDATE youtube_migration
       SET playlist_id = ?, playlist_url = ?, status = 'running', message = 'Playlist created', updated_at = datetime('now')
       WHERE id = 1`,
      [playlistId, `https://music.youtube.com/playlist?list=${playlistId}`],
    );
  }

  async reserveYoutubeQuota(units: number, day: string, maxUnits = 9500): Promise<boolean> {
    await this.run("INSERT OR IGNORE INTO youtube_migration (id, status, started_at, updated_at) VALUES (1, 'running', datetime('now'), datetime('now'))");
    const row = await this.first<{ quota_day: string | null; quota_used: number }>("SELECT quota_day, quota_used FROM youtube_migration WHERE id = 1");
    const used = row?.quota_day === day ? Number(row.quota_used) : 0;
    if (used + units > maxUnits) {
      await this.run(
        "UPDATE youtube_migration SET quota_day = ?, quota_used = ?, message = ?, updated_at = datetime('now') WHERE id = 1",
        [day, used, "Daily YouTube quota budget reached; will resume tomorrow."],
      );
      return false;
    }
    await this.run("UPDATE youtube_migration SET quota_day = ?, quota_used = ?, updated_at = datetime('now') WHERE id = 1", [day, used + units]);
    return true;
  }

  async markYoutubeMigrationItem(
    trackId: number,
    result: { status: "pending" | "added" | "skipped" | "error"; videoId?: string | null; videoTitle?: string | null; error?: string | null },
  ): Promise<void> {
    await this.run(
      `UPDATE youtube_migration_items
       SET status = ?, video_id = ?, video_title = ?, error = ?, added_at = CASE WHEN ? = 'added' THEN datetime('now') ELSE added_at END,
           updated_at = datetime('now')
       WHERE track_id = ?`,
      [result.status, result.videoId ?? null, result.videoTitle ?? null, result.error?.slice(0, 500) ?? null, result.status, trackId],
    );
    await this.refreshYoutubeMigrationCounts(result.error ?? null);
  }

  async noteYoutubeMigration(message: string): Promise<void> {
    await this.run("UPDATE youtube_migration SET message = ?, updated_at = datetime('now') WHERE id = 1", [message.slice(0, 500)]);
  }

  private async refreshYoutubeMigrationCounts(message: string | null = null): Promise<void> {
    await this.run(
      `UPDATE youtube_migration
       SET items_total = (SELECT COUNT(*) FROM youtube_migration_items),
           items_done = (SELECT COUNT(*) FROM youtube_migration_items WHERE status IN ('added', 'skipped', 'error')),
           added = (SELECT COUNT(*) FROM youtube_migration_items WHERE status = 'added'),
           skipped = (SELECT COUNT(*) FROM youtube_migration_items WHERE status = 'skipped'),
           failed = (SELECT COUNT(*) FROM youtube_migration_items WHERE status = 'error'),
           status = CASE
             WHEN (SELECT COUNT(*) FROM youtube_migration_items) = 0 THEN 'done'
             WHEN (SELECT COUNT(*) FROM youtube_migration_items WHERE status NOT IN ('added', 'skipped', 'error')) = 0 THEN 'done'
             ELSE 'running'
           END,
           finished_at = CASE
             WHEN (SELECT COUNT(*) FROM youtube_migration_items WHERE status NOT IN ('added', 'skipped', 'error')) = 0 THEN COALESCE(finished_at, datetime('now'))
             ELSE NULL
           END,
           message = COALESCE(?, message),
           updated_at = datetime('now')
       WHERE id = 1`,
      [message],
    );
  }

  // --- YouTube source sync -------------------------------------------------

  listYoutubeSyncPlaylists(): Promise<YouTubeSyncPlaylist[]> {
    return this.all<YouTubeSyncPlaylist>(
      `SELECT id, playlist_id, title, url, enabled, scan_limit, stop_after_known,
              last_sync_at, last_error, created_at, updated_at
       FROM youtube_sync_playlists
       ORDER BY enabled DESC, title COLLATE NOCASE, id`,
    );
  }

  youtubeSyncPlaylist(id: number): Promise<YouTubeSyncPlaylist | null> {
    return this.first<YouTubeSyncPlaylist>(
      `SELECT id, playlist_id, title, url, enabled, scan_limit, stop_after_known,
              last_sync_at, last_error, created_at, updated_at
       FROM youtube_sync_playlists
       WHERE id = ?`,
      [id],
    );
  }

  enabledYoutubeSyncPlaylists(id?: number): Promise<YouTubeSyncPlaylist[]> {
    return this.all<YouTubeSyncPlaylist>(
      `SELECT id, playlist_id, title, url, enabled, scan_limit, stop_after_known,
              last_sync_at, last_error, created_at, updated_at
       FROM youtube_sync_playlists
       WHERE enabled = 1 AND (? IS NULL OR id = ?)
       ORDER BY id`,
      [id ?? null, id ?? null],
    );
  }

  async upsertYoutubeSyncPlaylist(input: { playlistId: string; title?: string; enabled?: boolean; scanLimit?: number; stopAfterKnown?: number }): Promise<void> {
    const title = input.title?.trim() || input.playlistId;
    const scanLimit = Math.max(1, Math.min(50, Math.floor(input.scanLimit ?? 3)));
    const stopAfterKnown = Math.max(1, Math.min(200, Math.floor(input.stopAfterKnown ?? 25)));
    await this.run(
      `INSERT INTO youtube_sync_playlists (playlist_id, title, url, enabled, scan_limit, stop_after_known, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(playlist_id) DO UPDATE SET
         title = excluded.title,
         url = excluded.url,
         enabled = excluded.enabled,
         scan_limit = excluded.scan_limit,
         stop_after_known = excluded.stop_after_known,
         updated_at = datetime('now')`,
      [input.playlistId, title, youtubeMusicPlaylistUrl(input.playlistId), input.enabled === false ? 0 : 1, scanLimit, stopAfterKnown],
    );
  }

  async updateYoutubeSyncPlaylist(id: number, input: { title: string; enabled: boolean; scanLimit?: number; stopAfterKnown?: number }): Promise<void> {
    const title = input.title.trim();
    if (!title) throw new Error("Playlist title is required");
    await this.run(
      `UPDATE youtube_sync_playlists
       SET title = ?, enabled = ?, scan_limit = ?, stop_after_known = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        title,
        input.enabled ? 1 : 0,
        Math.max(1, Math.min(50, Math.floor(input.scanLimit ?? 3))),
        Math.max(1, Math.min(200, Math.floor(input.stopAfterKnown ?? 25))),
        id,
      ],
    );
  }

  async deleteYoutubeSyncPlaylist(id: number): Promise<void> {
    const playlist = await this.youtubeSyncPlaylist(id);
    if (!playlist) return;
    await this.env.DB.batch([
      this.stmt("DELETE FROM youtube_sync_items WHERE playlist_id = ?", [playlist.playlist_id]),
      this.stmt("DELETE FROM youtube_sync_playlists WHERE id = ?", [id]),
    ]);
  }

  recentYoutubeSyncRun(): Promise<YouTubeSyncRun | null> {
    return this.first<YouTubeSyncRun>(
      `SELECT id, status, mode, playlists_total, playlists_done, pages_fetched, items_seen,
              imported, duplicates, skipped, failed, message, started_at, finished_at
       FROM youtube_sync_runs
       ORDER BY id DESC
       LIMIT 1`,
    );
  }

  async startYoutubeSyncRun(playlistsTotal: number, mode = "incremental"): Promise<number> {
    return Number(await this.scalar(
      `INSERT INTO youtube_sync_runs (status, mode, playlists_total, message)
       VALUES ('running', ?, ?, 'Sync started')
       RETURNING id AS value`,
      [mode, playlistsTotal],
    ));
  }

  async noteYoutubeSyncRun(
    runId: number,
    delta: Partial<Pick<YouTubeSyncRun, "playlists_done" | "pages_fetched" | "items_seen" | "imported" | "duplicates" | "skipped" | "failed">> & { message?: string | null; done?: boolean },
  ): Promise<void> {
    await this.run(
      `UPDATE youtube_sync_runs
       SET playlists_done = playlists_done + ?,
           pages_fetched = pages_fetched + ?,
           items_seen = items_seen + ?,
           imported = imported + ?,
           duplicates = duplicates + ?,
           skipped = skipped + ?,
           failed = failed + ?,
           message = COALESCE(?, message),
           status = CASE WHEN ? THEN CASE WHEN failed + ? > 0 THEN 'done_with_errors' ELSE 'done' END ELSE status END,
           finished_at = CASE WHEN ? THEN datetime('now') ELSE finished_at END
       WHERE id = ?`,
      [
        delta.playlists_done ?? 0,
        delta.pages_fetched ?? 0,
        delta.items_seen ?? 0,
        delta.imported ?? 0,
        delta.duplicates ?? 0,
        delta.skipped ?? 0,
        delta.failed ?? 0,
        delta.message?.slice(0, 500) ?? null,
        delta.done ? 1 : 0,
        delta.failed ?? 0,
        delta.done ? 1 : 0,
        runId,
      ],
    );
  }

  async noteYoutubeSyncPlaylist(id: number, result: { ok: boolean; error?: string | null }): Promise<void> {
    await this.run(
      `UPDATE youtube_sync_playlists
       SET last_sync_at = CASE WHEN ? THEN datetime('now') ELSE last_sync_at END,
           last_error = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
      [result.ok ? 1 : 0, result.error?.slice(0, 500) ?? null, id],
    );
  }

  async existingYoutubeSyncPlaylistItems(playlistId: string, playlistItemIds: string[]): Promise<Set<string>> {
    const ids = playlistItemIds.filter(Boolean);
    if (!ids.length) return new Set();
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await this.all<{ playlist_item_id: string }>(
      `SELECT playlist_item_id
       FROM youtube_sync_items
       WHERE playlist_id = ? AND playlist_item_id IN (${placeholders})`,
      [playlistId, ...ids],
    );
    return new Set(rows.map((row) => row.playlist_item_id));
  }

  async saveSyncedYouTubeVideo(input: SyncedYouTubeVideo): Promise<{ sourceId: number; duplicate: boolean; itemKind: ItemKind; itemId: number; title: string }> {
    const url = `https://www.youtube.com/watch?v=${input.videoId}`;
    const existing = await this.first<{ id: number; title: string | null; item_kind: ItemKind | null; item_id: number | null; saved_at: string | null }>(
      "SELECT id, title, item_kind, item_id, saved_at FROM item_sources WHERE provider = 'youtube' AND item_kind = 'track' AND provider_id = ?",
      [input.videoId],
    );
    if (existing?.saved_at && existing.item_kind === "track" && existing.item_id !== null) {
      await this.recordYoutubeSyncItem(input, existing.id, "track", existing.item_id);
      return { sourceId: existing.id, duplicate: true, itemKind: "track", itemId: existing.item_id, title: existing.title ?? input.title };
    }

    const fetched = videoToTrack(input.title, input.channelTitle, input.thumbnailUrl);
    const up = await this.upsertEntity(fetched);
    await this.enqueueEnrich(up.itemKind, up.itemId);
    await this.enqueueRelated(up.itemKind, up.itemId);
    const rawJson = JSON.stringify(input.rawJson ?? { title: input.title, channelTitle: input.channelTitle });

    let sourceId: number;
    if (existing) {
      sourceId = existing.id;
      await this.run(
        `UPDATE item_sources
         SET item_id = ?, url = ?, title = ?, status = 'ok', raw_json = ?,
             saved_at = COALESCE(saved_at, datetime('now')), saved_via = COALESCE(saved_via, 'youtube-sync')
         WHERE id = ?`,
        [up.itemId, url, up.title, rawJson, sourceId],
      );
    } else {
      const saved = await this.saveItemSource({
        provider: "youtube",
        providerId: input.videoId,
        itemKind: up.itemKind,
        itemId: up.itemId,
        url,
        title: up.title,
        status: "ok",
        rawJson,
        savedVia: "youtube-sync",
      });
      sourceId = saved.id;
    }

    await this.recordYoutubeSyncItem(input, sourceId, up.itemKind, up.itemId);
    return { sourceId, duplicate: !!existing?.saved_at, itemKind: up.itemKind, itemId: up.itemId, title: up.title };
  }

  private async recordYoutubeSyncItem(input: SyncedYouTubeVideo, sourceId: number, itemKind: ItemKind, itemId: number): Promise<void> {
    await this.run(
      `INSERT INTO youtube_sync_items (
         playlist_id, playlist_item_id, video_id, item_source_id, item_kind, item_id,
         title, channel_title, position, raw_json, first_seen_at, last_seen_at, removed_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL)
       ON CONFLICT(playlist_id, playlist_item_id) DO UPDATE SET
         video_id = excluded.video_id,
         item_source_id = excluded.item_source_id,
         item_kind = excluded.item_kind,
         item_id = excluded.item_id,
         title = excluded.title,
         channel_title = excluded.channel_title,
         position = excluded.position,
         raw_json = excluded.raw_json,
         last_seen_at = datetime('now'),
         removed_at = NULL`,
      [
        input.playlistId,
        input.playlistItemId,
        input.videoId,
        sourceId,
        itemKind,
        itemId,
        input.title,
        input.channelTitle ?? null,
        input.position ?? null,
        JSON.stringify(input.rawJson ?? {}),
      ],
    );
  }

  /** Artists that have at least one album or track, with counts, for /library. */
  listArtists(limit = 50, offset = 0, sort?: string): Promise<PageResult<ArtistSummary>> {
    const sql =
      `WITH album_counts AS (
         SELECT artist_id, COUNT(*) AS albums
         FROM albums
         WHERE artist_id IS NOT NULL
         GROUP BY artist_id
       ), track_credits AS (
         SELECT artist_id, track_id FROM track_artists
         UNION ALL
         SELECT t.artist_id, t.id
         FROM tracks t
         WHERE t.artist_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM track_artists ta WHERE ta.track_id = t.id)
       ), track_counts AS (
         SELECT artist_id, COUNT(*) AS tracks
         FROM track_credits
         GROUP BY artist_id
       )
       SELECT a.id, a.name, a.artist_type, a.image_url, a.image_key,
              COALESCE(ac.albums, 0) AS albums,
              COALESCE(tc.tracks, 0) AS tracks
       FROM artists a
       LEFT JOIN album_counts ac ON ac.artist_id = a.id
       LEFT JOIN track_counts tc ON tc.artist_id = a.id
       WHERE a.artist_type = 'musician' AND (ac.artist_id IS NOT NULL OR tc.artist_id IS NOT NULL)
       ORDER BY ${pickSort(ARTIST_SORTS, sort)}`;
    return this.page<ArtistSummary>(sql, `WITH active_artists AS (
      SELECT artist_id FROM albums WHERE artist_id IS NOT NULL
      UNION
      SELECT artist_id FROM track_artists
      UNION
      SELECT t.artist_id FROM tracks t
      WHERE t.artist_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM track_artists ta WHERE ta.track_id = t.id)
    )
    SELECT COUNT(*) AS value
    FROM active_artists aa
    JOIN artists a ON a.id = aa.artist_id
    WHERE a.artist_type = 'musician'`, [], limit, offset);
  }

  /** Albums with artist and track counts, for the music album view. */
  listAlbums(limit = 50, offset = 0, sort?: string): Promise<PageResult<AlbumRow>> {
    return this.page<AlbumRow>(
      `SELECT al.id, al.title, al.year, al.cover_url, al.cover_key, al.rating,
              al.artist_id, a.name AS artist,
              (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS tracks
       FROM albums al
       LEFT JOIN artists a ON a.id = al.artist_id
       ORDER BY ${pickSort(ALBUM_SORTS, sort)}`, "SELECT COUNT(*) AS value FROM albums", [], limit, offset,
    );
  }

  /** Tracks with album and disaggregated artist display, for the music track view. */
  listTracks(limit = 50, offset = 0, opts: { sort?: string; favorites?: boolean } = {}): Promise<PageResult<TrackRow>> {
    const where = opts.favorites ? "WHERE t.favorite = 1" : "";
    return this.page<TrackRow>(
      `SELECT t.id, t.title, t.duration_ms, t.album_id, t.artist_id, t.rating, t.favorite,
              al.title AS album, a.name AS artist,
              COALESCE(
                (SELECT group_concat(name, ', ')
                 FROM (
                   SELECT ar.name
                   FROM track_artists ta
                   JOIN artists ar ON ar.id = ta.artist_id
                   WHERE ta.track_id = t.id
                   ORDER BY ta.position, ar.name COLLATE NOCASE
                 )),
                a.name
              ) AS artists
       FROM tracks t
       LEFT JOIN albums al ON al.id = t.album_id
       LEFT JOIN artists a ON a.id = t.artist_id
       ${where}
       ORDER BY ${pickSort(TRACK_SORTS, opts.sort)}`, `SELECT COUNT(*) AS value FROM tracks t ${where}`, [], limit, offset,
    );
  }

  /** Artist page: the artist plus their albums and tracks. */
  async artistDetail(id: number): Promise<ArtistDetail | null> {
    const artist = await this.first<ArtistDetail["artist"]>("SELECT id, name, artist_type, image_url, image_key, genres FROM artists WHERE id = ?", [id]);
    if (!artist) return null;
    const albums = await this.all<AlbumRow>(
      `SELECT al.id, al.title, al.year, al.cover_url, al.cover_key, al.rating,
              al.artist_id, a.name AS artist,
              (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS tracks
       FROM albums al
       LEFT JOIN artists a ON a.id = al.artist_id
       WHERE al.artist_id = ?
       ORDER BY al.year, al.title COLLATE NOCASE`,
      [id],
    );
    const tracks = await this.all<TrackRow>(
      `SELECT t.id, t.title, t.duration_ms, t.album_id, t.artist_id, t.rating, t.favorite,
              al.title AS album, pa.name AS artist,
              COALESCE(
                (SELECT group_concat(name, ', ')
                 FROM (
                   SELECT ar.name
                   FROM track_artists ta
                   JOIN artists ar ON ar.id = ta.artist_id
                   WHERE ta.track_id = t.id
                   ORDER BY ta.position, ar.name COLLATE NOCASE
                 )),
                pa.name
              ) AS artists
       FROM tracks t
       LEFT JOIN albums al ON al.id = t.album_id
       LEFT JOIN artists pa ON pa.id = t.artist_id
       WHERE EXISTS (SELECT 1 FROM track_artists ta WHERE ta.track_id = t.id AND ta.artist_id = ?)
          OR (t.artist_id = ? AND NOT EXISTS (SELECT 1 FROM track_artists ta2 WHERE ta2.track_id = t.id))
       ORDER BY t.title COLLATE NOCASE`,
      [id, id],
    );
    return { artist, albums, tracks };
  }

  async albumDetail(id: number): Promise<AlbumDetail | null> {
    const album = await this.first<AlbumRow>(
      `SELECT al.id, al.title, al.year, al.cover_url, al.cover_key, al.rating,
              al.artist_id, a.name AS artist,
              (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS tracks
       FROM albums al
       LEFT JOIN artists a ON a.id = al.artist_id
       WHERE al.id = ?`,
      [id],
    );
    if (!album) return null;
    const tracks = await this.all<TrackRow>(
      `SELECT t.id, t.title, t.duration_ms, t.album_id, t.artist_id, t.rating, t.favorite,
              al.title AS album, pa.name AS artist,
              COALESCE(
                (SELECT group_concat(name, ', ')
                 FROM (
                   SELECT ar.name
                   FROM track_artists ta
                   JOIN artists ar ON ar.id = ta.artist_id
                   WHERE ta.track_id = t.id
                   ORDER BY ta.position, ar.name COLLATE NOCASE
                 )),
                pa.name
              ) AS artists
       FROM tracks t
       LEFT JOIN albums al ON al.id = t.album_id
       LEFT JOIN artists pa ON pa.id = t.artist_id
       WHERE t.album_id = ?
       ORDER BY t.id`,
      [id],
    );
    return { album, tracks };
  }

  async trackDetail(id: number): Promise<TrackDetail | null> {
    const track = await this.first<TrackRow>(
      `SELECT t.id, t.title, t.duration_ms, t.album_id, t.artist_id, t.rating, t.favorite,
              al.title AS album, pa.name AS artist,
              COALESCE(
                (SELECT group_concat(name, ', ')
                 FROM (
                   SELECT ar.name
                   FROM track_artists ta
                   JOIN artists ar ON ar.id = ta.artist_id
                   WHERE ta.track_id = t.id
                   ORDER BY ta.position, ar.name COLLATE NOCASE
                 )),
                pa.name
              ) AS artists
       FROM tracks t
       LEFT JOIN albums al ON al.id = t.album_id
       LEFT JOIN artists pa ON pa.id = t.artist_id
       WHERE t.id = ?`,
      [id],
    );
    if (!track) return null;
    let artists = await this.all<TrackArtistRow>(
      `SELECT a.id, a.name, ta.role
       FROM track_artists ta
       JOIN artists a ON a.id = ta.artist_id
       WHERE ta.track_id = ?
       ORDER BY ta.position, a.name COLLATE NOCASE`,
      [id],
    );
    if (!artists.length && track.artist_id && track.artist) artists = [{ id: track.artist_id, name: track.artist, role: "main" }];
    return { track, artists };
  }

  /** Full book record with joined authors for the detail page. */
  bookDetail(id: number): Promise<BookDetail | null> {
    return this.first<BookDetail>(
      `SELECT b.id, b.title, b.cover_url, b.cover_key, b.year, b.publisher, b.page_count, b.isbn,
              b.description, b.reading_status, b.rating,
              (SELECT group_concat(a.name, ', ') FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id) AS author
       FROM books b WHERE b.id = ?`,
      [id],
    );
  }

  // --- ratings / status ----------------------------------------------------

  /** Set a 1-5 rating (0 clears it) on a track, album, book, or media item. */
  async rate(kind: RatableKind, id: number, rating: number): Promise<number> {
    const table = { track: "tracks", album: "albums", book: "books", media: "media_items" }[kind];
    const v = Math.max(0, Math.min(5, Math.round(rating)));
    await this.run(`UPDATE ${table} SET rating = ? WHERE id = ?`, [v || null, id]);
    return v;
  }

  async setReadingStatus(id: number, status: ReadingStatus): Promise<void> {
    await this.run("UPDATE books SET reading_status = ? WHERE id = ?", [status, id]);
  }

  async toggleFavorite(trackId: number): Promise<boolean> {
    const row = await this.first<{ favorite: number }>("SELECT favorite FROM tracks WHERE id = ?", [trackId]);
    const next = row && Number(row.favorite) ? 0 : 1;
    await this.run("UPDATE tracks SET favorite = ? WHERE id = ?", [next, trackId]);
    return next === 1;
  }

  /** All books with their primary author, for /books. */
  listBooks(limit = 50, offset = 0, opts: { sort?: string; status?: string } = {}): Promise<PageResult<BookRow>> {
    const status = READING_STATUSES.includes(opts.status as ReadingStatus) ? (opts.status as ReadingStatus) : null;
    const where = status ? "WHERE b.reading_status = ?" : "";
    const args: SqlValue[] = status ? [status] : [];
    return this.page<BookRow>(
      `SELECT b.id, b.title, b.cover_url, b.cover_key, b.year, b.reading_status,
              (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
               WHERE ba.book_id = b.id ORDER BY ba.position LIMIT 1) AS author
       FROM books b ${where} ORDER BY ${pickSort(BOOK_SORTS, opts.sort)}`,
      `SELECT COUNT(*) AS value FROM books b ${where}`, args, limit, offset,
    );
  }

  /** Visual media by category, for /movies, /series, /anime, /manga, /webtoons, /comics. */
  listMedia(kind: VisualKind, limit = 50, offset = 0, opts: { sort?: string; status?: string } = {}): Promise<PageResult<MediaRow>> {
    let where = "WHERE kind = ?";
    const args: SqlValue[] = [kind];
    if (opts.status === "todo") {
      where += ` AND (list_status IS NULL OR lower(list_status) NOT IN (${DONE_STATUSES.map(() => "?").join(", ")}))`;
      args.push(...DONE_STATUSES);
    } else if (opts.status) {
      where += " AND list_status = ?";
      args.push(opts.status);
    }
    return this.page<MediaRow>(
      `SELECT id, kind, title, cover_url, cover_key, year, rating,
              media_format, list_status, progress_current, progress_total, personal_score
       FROM media_items ${where} ORDER BY ${pickSort(MEDIA_SORTS, opts.sort)}`,
      `SELECT COUNT(*) AS value FROM media_items ${where}`, args, limit, offset,
    );
  }

  /** Distinct list_status values present for a media kind, for the filter dropdown. */
  async mediaStatuses(kind: VisualKind): Promise<string[]> {
    const rows = await this.all<{ value: string }>(
      "SELECT DISTINCT list_status AS value FROM media_items WHERE kind = ? AND list_status IS NOT NULL AND list_status != '' ORDER BY 1",
      [kind],
    );
    return rows.map((row) => row.value);
  }

  mediaDetail(id: number): Promise<MediaDetail | null> {
    return this.first<MediaDetail>(
      `SELECT media.id, media.kind, media.title, media.cover_url, media.cover_key, media.year, media.description, media.rating,
              (SELECT provider FROM item_sources WHERE item_kind = media.kind AND item_id = media.id ORDER BY is_primary DESC, saved_at DESC LIMIT 1) AS provider,
              (SELECT url FROM item_sources WHERE item_kind = media.kind AND item_id = media.id ORDER BY is_primary DESC, saved_at DESC LIMIT 1) AS provider_url,
              media_format, list_status, progress_current, progress_total, personal_score, notes, tags
       FROM media_items AS media WHERE media.id = ?`,
      [id],
    );
  }

  // --- editing -------------------------------------------------------------

  async updateArtist(id: number, input: { name: string; artistType?: ArtistType; genres?: string; imageUrl?: string }): Promise<void> {
    const name = input.name.trim();
    if (!name) throw new Error("Artist name is required");
    await this.run("UPDATE artists SET name = ?, normalized_name = ?, artist_type = ?, genres = ?, image_url = ? WHERE id = ?", [name, normalize(name), artistType(input.artistType), input.genres?.trim() || null, input.imageUrl?.trim() || null, id]);
  }

  async updateAlbum(id: number, input: { title: string; artist: string; year?: number | null }): Promise<void> {
    const title = input.title.trim();
    if (!title) throw new Error("Album title is required");
    const artistId = await this.getOrCreateArtist(input.artist.trim() || "Unknown");
    await this.run("UPDATE albums SET title = ?, normalized_title = ?, artist_id = ?, year = ? WHERE id = ?", [title, normalize(title), artistId, input.year ?? null, id]);
  }

  async updateTrack(id: number, input: { title: string; artists: string; album?: string; durationMs?: number | null }): Promise<void> {
    const title = input.title.trim();
    const credits = splitArtists(input.artists);
    if (!title) throw new Error("Track title is required");
    if (!credits.length) throw new Error("At least one artist is required");
    const primaryId = await this.getOrCreateArtist(credits[0].name);
    const albumId = input.album?.trim() ? await this.getOrCreateAlbum(input.album.trim(), primaryId) : null;
    await this.run("UPDATE tracks SET title = ?, normalized_title = ?, artist_id = ?, album_id = ?, duration_ms = ? WHERE id = ?", [title, normalize(title), primaryId, albumId, input.durationMs ?? null, id]);
    await this.run("DELETE FROM track_artists WHERE track_id = ?", [id]);
    for (const [position, credit] of credits.entries()) {
      const artistId = await this.getOrCreateArtist(credit.name);
      await this.run("INSERT INTO track_artists (track_id, artist_id, position, role) VALUES (?, ?, ?, ?)", [id, artistId, position, credit.role]);
    }
  }

  async updateBook(id: number, input: { title: string; authors: string; year?: number | null; publisher?: string; pageCount?: number | null; isbn?: string; description?: string }): Promise<void> {
    const title = input.title.trim();
    if (!title) throw new Error("Book title is required");
    await this.run(
      "UPDATE books SET title = ?, normalized_title = ?, year = ?, publisher = ?, page_count = ?, isbn = ?, description = ? WHERE id = ?",
      [title, normalize(title), input.year ?? null, input.publisher?.trim() || null, input.pageCount ?? null, input.isbn?.trim() || null, input.description?.trim() || null, id],
    );
    await this.run("DELETE FROM book_authors WHERE book_id = ?", [id]);
    for (const [position, name] of input.authors.split(/,\s*/).entries()) {
      if (!name.trim()) continue;
      const authorId = await this.getOrCreateAuthor(name.trim());
      await this.run("INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)", [id, authorId, position]);
    }
  }

  async updateMedia(id: number, input: { title: string; year?: number | null; description?: string; notes?: string; tags?: string; format?: string; status?: string; progressCurrent?: number | null; progressTotal?: number | null; personalScore?: number | null }): Promise<void> {
    const title = input.title.trim();
    if (!title) throw new Error("Title is required");
    await this.run(
      `UPDATE media_items SET title = ?, normalized_title = ?, year = ?, description = ?, notes = ?, tags = ?, media_format = ?, list_status = ?,
       progress_current = ?, progress_total = ?, personal_score = ? WHERE id = ?`,
      [title, normalize(title), input.year ?? null, input.description?.trim() || null, input.notes?.trim() || null, input.tags?.trim() || null, input.format?.trim() || null, input.status?.trim() || null, input.progressCurrent ?? null, input.progressTotal ?? null, input.personalScore ?? null, id],
    );
  }

  async seedLiveShows(shows: LiveShow[]): Promise<void> {
    const count = Number(await this.scalar("SELECT COUNT(*) AS value FROM live_shows"));
    if (count) return;
    for (const show of shows) {
      await this.run(
        `INSERT OR IGNORE INTO live_shows (slug, artist, date, date_label, venue, city, context, companions, summary, notes_json, tags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [show.slug, show.artist, show.date, show.dateLabel, show.venue, show.city ?? null, show.context ?? null, show.companions ?? null, show.summary, JSON.stringify(show.notes), JSON.stringify(show.tags)],
      );
    }
  }

  async listLiveShows(): Promise<LiveShow[]> {
    const rows = await this.all<Record<string, unknown>>("SELECT slug, artist, date, date_label, venue, city, context, companions, summary, notes_json, tags_json FROM live_shows ORDER BY date DESC, slug DESC");
    return rows.map((row) => ({
      slug: String(row.slug), artist: String(row.artist), date: row.date ? String(row.date) : null, dateLabel: String(row.date_label), venue: String(row.venue),
      city: row.city ? String(row.city) : undefined, context: row.context ? String(row.context) : undefined, companions: row.companions ? String(row.companions) : undefined,
      summary: String(row.summary), notes: parseStringList(row.notes_json), tags: parseStringList(row.tags_json),
    }));
  }

  async liveShow(slug: string): Promise<LiveShow | null> {
    return (await this.listLiveShows()).find((show) => show.slug === slug) ?? null;
  }

  async createLiveShow(input: LiveShowInput): Promise<string> {
    const artist = input.artist.trim();
    if (!artist) throw new Error("Artist is required");
    const base = normalize(`${artist}-${input.date ?? ""}-${input.venue ?? "show"}`).replace(/ /g, "-") || "live-show";
    let slug = base;
    for (let suffix = 2; await this.first<{ slug: string }>("SELECT slug FROM live_shows WHERE slug = ?", [slug]); suffix++) slug = `${base}-${suffix}`;
    await this.writeLiveShow(slug, input);
    return slug;
  }

  async updateLiveShow(slug: string, input: LiveShowInput): Promise<void> {
    if (!input.artist.trim()) throw new Error("Artist is required");
    await this.writeLiveShow(slug, input, true);
  }

  async deleteLiveShow(slug: string): Promise<void> { await this.run("DELETE FROM live_shows WHERE slug = ?", [slug]); }

  async deleteEntry(kind: "artist" | "album" | "track" | "book" | "media", id: number): Promise<void> {
    const table = { artist: "artists", album: "albums", track: "tracks", book: "books", media: "media_items" }[kind];
    const imageColumn = kind === "artist" ? "image_key" : kind === "album" || kind === "book" || kind === "media" ? "cover_key" : null;
    const row = await this.first<{ image_key: string | null; item_kind: ItemKind }>(
      `SELECT ${imageColumn ? imageColumn : "NULL"} AS image_key, ${kind === "media" ? "kind" : `'${kind}'`} AS item_kind FROM ${table} WHERE id = ?`,
      [id],
    );
    if (!row) return;

    const statements: D1PreparedStatement[] = [];
    if (kind === "artist") {
      statements.push(
        this.stmt("UPDATE albums SET artist_id = NULL WHERE artist_id = ?", [id]),
        this.stmt("UPDATE tracks SET artist_id = NULL WHERE artist_id = ?", [id]),
        this.stmt("DELETE FROM track_artists WHERE artist_id = ?", [id]),
      );
    }
    if (kind === "album") statements.push(this.stmt("UPDATE tracks SET album_id = NULL WHERE album_id = ?", [id]));
    if (kind === "track") statements.push(this.stmt("DELETE FROM track_artists WHERE track_id = ?", [id]));
    if (kind === "book") statements.push(this.stmt("DELETE FROM book_authors WHERE book_id = ?", [id]));
    statements.push(
      this.stmt("DELETE FROM item_sources WHERE item_kind = ? AND item_id = ?", [row.item_kind, id]),
      this.stmt("DELETE FROM enrich_queue WHERE item_kind = ? AND item_id = ?", [row.item_kind, id]),
      this.stmt(`DELETE FROM ${table} WHERE id = ?`, [id]),
    );
    await this.env.DB.batch(statements);

    if (row.image_key) {
      await this.env.MEDIA.delete(row.image_key).catch((error) => {
        console.error("failed to delete cached media", { key: row.image_key, error: String(error) });
      });
    }
  }

  private async writeLiveShow(slug: string, input: LiveShowInput, exists = false): Promise<void> {
    const date = input.date?.trim() || null;
    const label = input.dateLabel?.trim() || date || "Date not noted";
    const values: SqlValue[] = [input.artist.trim(), date, label, input.venue?.trim() || "", input.city?.trim() || null, input.context?.trim() || null, input.companions?.trim() || null, input.summary?.trim() || "", JSON.stringify(splitLines(input.notes)), JSON.stringify(splitComma(input.tags)), slug];
    if (exists) await this.run("UPDATE live_shows SET artist=?, date=?, date_label=?, venue=?, city=?, context=?, companions=?, summary=?, notes_json=?, tags_json=? WHERE slug=?", values);
    else await this.run("INSERT INTO live_shows (artist, date, date_label, venue, city, context, companions, summary, notes_json, tags_json, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", values);
  }

  /** Fuzzy search across music, books, and visual media. */
  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const like = `%${normalize(query)}%`;
    if (like === "%%") return [];
    const rows = await this.all<{ type: string; id: number; name: string; sub: string }>(`SELECT * FROM (
      SELECT 'artist' AS type, id, name, CASE artist_type WHEN 'musician' THEN '' ELSE replace(artist_type, '_', ' ') END AS sub FROM artists WHERE normalized_name LIKE ?
      UNION ALL
      SELECT 'album', al.id, al.title, COALESCE(a.name, '') FROM albums al LEFT JOIN artists a ON a.id = al.artist_id WHERE al.normalized_title LIKE ?
      UNION ALL
      SELECT 'track', t.id, t.title,
        COALESCE(
          (SELECT group_concat(name, ', ')
           FROM (
             SELECT ar.name
             FROM track_artists ta
             JOIN artists ar ON ar.id = ta.artist_id
             WHERE ta.track_id = t.id
             ORDER BY ta.position, ar.name COLLATE NOCASE
           )),
          a.name,
          ''
        )
        FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.normalized_title LIKE ?
      UNION ALL
      SELECT 'book', b.id, b.title, COALESCE((SELECT group_concat(a.name, ', ') FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id), '')
        FROM books b WHERE b.normalized_title LIKE ? OR EXISTS (
          SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id AND a.normalized_name LIKE ?
        )
      UNION ALL
      SELECT 'media', id, title, kind || CASE WHEN year IS NULL THEN '' ELSE ' · ' || year END FROM media_items WHERE normalized_title LIKE ?
    ) LIMIT ?`, [like, like, like, like, like, like, Math.max(1, Math.min(100, limit))]);
    const prefix: Record<string, string> = { artist: "/artist/", album: "/album/", track: "/track/", book: "/book/", media: "/item/" };
    return rows.map((row) => ({ ...row, href: `${prefix[row.type] ?? "/item/"}${row.id}` }));
  }

  // --- ingestion -----------------------------------------------------------

  /** Save a link: classify -> dedupe -> fetch metadata -> upsert -> record. */
  async saveLink(url: string, via: SaveVia = "web"): Promise<SaveResult> {
    const c = classify(url);
    if (!c) return { ok: false, error: "Unrecognized link" };

    const existing = await this.first<{ id: number; title: string | null; status: string; item_kind: ItemKind | null; saved_at: string | null }>(
      "SELECT id, title, status, item_kind, saved_at FROM item_sources WHERE provider = ? AND item_kind IS ? AND provider_id = ?",
      [c.provider, c.itemKind, c.providerId],
    );
    if (existing?.saved_at) {
      return {
        ok: true,
        duplicate: true,
        linkId: existing.id,
        status: existing.status,
        itemKind: existing.item_kind,
        title: existing.title ?? url,
      };
    }

    let fetched: Fetched | null = null;
    let error: string | undefined;
    try {
      fetched = await fetchMetadata(c, this.env);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    let itemKind = c.itemKind;
    let itemId: number | null = null;
    let title = url;
    if (fetched) {
      const up = await this.upsertEntity(fetched);
      itemKind = up.itemKind;
      itemId = up.itemId;
      title = up.title;
      await this.enqueueEnrich(itemKind, itemId);
      await this.enqueueRelated(itemKind, itemId);
    }
    const status = fetched ? "ok" : error ? "error" : "pending";

    const saved = await this.saveItemSource({
      provider: c.provider, providerId: c.providerId, itemKind, itemId, url, title, status,
      rawJson: JSON.stringify(fetched ?? (error ? { error } : {})), savedVia: via,
    });
    return { ok: true, duplicate: saved.duplicate, linkId: saved.id, status, itemKind, title, error };
  }

  /** Save a name entered by a user, resolving it against a public catalogue when possible. */
  async saveText(kind: TextAddKind, text: string, via: SaveVia = "telegram", creator = "", inputArtistType: ArtistType = "musician"): Promise<SaveResult> {
    const query = text.trim();
    if (!query) return { ok: false, error: "Enter a title or name" };
    const creatorName = creator.trim();
    const requestedArtistType = artistType(inputArtistType);
    let resolved;
    let error: string | undefined;
    try {
      resolved = kind === "artist" && requestedArtistType !== "musician" ? null : await resolveText(kind, query, this.env.TMDB_API_TOKEN, creatorName);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    const fallback: Fetched = kind === "artist" ? { kind: "artist", name: query, artistType: requestedArtistType }
      : kind === "album" ? { kind: "album", title: query, artist: creatorName || "Unknown" }
      : kind === "track" ? { kind: "track", title: query, artist: creatorName || "Unknown" }
      : kind === "book" ? { kind: "book", title: query, author: creatorName || "Unknown" }
      : { kind, title: query };
    const provider = resolved?.provider ?? "manual";
    const providerId = resolved?.providerId ?? `${kind}:${normalize(query)}:${normalize(creatorName)}:${kind === "artist" ? requestedArtistType : ""}`;
    const url = resolved?.url ?? `text:${encodeURIComponent(query)}`;
    const existing = await this.first<{ id: number; title: string | null; status: string; item_kind: ItemKind | null; saved_at: string | null }>(
      "SELECT id, title, status, item_kind, saved_at FROM item_sources WHERE provider = ? AND item_kind = ? AND provider_id = ?", [provider, kind, providerId],
    );
    if (existing?.saved_at) return { ok: true, duplicate: true, linkId: existing.id, status: existing.status, itemKind: existing.item_kind, title: existing.title ?? query };
    const fetched = resolved?.fetched ?? fallback;
    const up = await this.upsertEntity(fetched);
    if (!(fetched.kind === "artist" && artistType(fetched.artistType) !== "musician")) await this.enqueueEnrich(up.itemKind, up.itemId);
    await this.enqueueRelated(up.itemKind, up.itemId);
    const status = resolved ? "ok" : "pending";
    const saved = await this.saveItemSource({
      provider, providerId, itemKind: up.itemKind, itemId: up.itemId, url, title: up.title, status,
      rawJson: JSON.stringify(resolved?.fetched ?? { query, error: error ?? "No catalogue match" }), savedVia: via,
    });
    return { ok: true, duplicate: saved.duplicate, linkId: saved.id, status, itemKind: up.itemKind, title: up.title, error: error ?? (resolved ? undefined : "No catalogue match") };
  }

  async setTelegramAddMode(chatId: number, userId: number, mode: TelegramAddMode): Promise<void> {
    await this.kvSet(`telegram:add:${chatId}:${userId}`, mode);
  }

  async takeTelegramAddMode(chatId: number, userId: number): Promise<TelegramAddMode | null> {
    const key = `telegram:add:${chatId}:${userId}`;
    const value = await this.kvGet(key);
    if (value) await this.run("DELETE FROM kv WHERE key = ?", [key]);
    return value === "live" || isTextAddKind(value) ? value : null;
  }

  async clearTelegramAddMode(chatId: number, userId: number): Promise<void> {
    await this.run("DELETE FROM kv WHERE key = ?", [`telegram:add:${chatId}:${userId}`]);
  }

  // --- bulk import (migration from the legacy SQLite catalog) --------------

  async resetCatalog(): Promise<void> {
    for (const t of ["track_artists", "tracks", "albums", "artists", "book_authors", "books", "authors", "media_items", "item_sources", "enrich_queue"]) {
      await this.run(`DELETE FROM ${t}`);
    }
  }

  private async kvGet(key: string): Promise<string | null> {
    const row = await this.first<{ value: string | null }>("SELECT value FROM kv WHERE key = ?", [key]);
    return row?.value ?? null;
  }

  private async kvSet(key: string, value: string): Promise<void> {
    await this.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  private async saveItemSource(input: {
    provider: Provider;
    providerId: string;
    itemKind: ItemKind | null;
    itemId: number | null;
    url: string;
    title: string;
    status: string;
    rawJson: string;
    savedVia: SaveVia;
  }): Promise<{ id: number; duplicate: boolean }> {
    const existing = await this.first<{ id: number; saved_at: string | null }>(
      "SELECT id, saved_at FROM item_sources WHERE provider = ? AND item_kind IS ? AND provider_id = ?",
      [input.provider, input.itemKind, input.providerId],
    );
    if (existing?.saved_at) return { id: existing.id, duplicate: true };

    if (existing) {
      await this.run(
        `UPDATE item_sources SET item_id = COALESCE(item_id, ?), url = ?, title = ?, status = ?, raw_json = ?,
           saved_at = datetime('now'), saved_via = ? WHERE id = ?`,
        [input.itemId, input.url, input.title, input.status, input.rawJson, input.savedVia, existing.id],
      );
      return { id: existing.id, duplicate: false };
    }

    const hasPrimary = input.itemKind && input.itemId !== null
      ? await this.first<{ id: number }>("SELECT id FROM item_sources WHERE item_kind = ? AND item_id = ? AND is_primary = 1", [input.itemKind, input.itemId])
      : null;
    const isPrimary = input.itemKind !== null && input.itemId !== null && !hasPrimary;
    await this.run(
      `INSERT OR IGNORE INTO item_sources
         (item_kind, item_id, provider, provider_id, url, title, status, raw_json, saved_at, saved_via, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`,
      [input.itemKind, input.itemId, input.provider, input.providerId, input.url, input.title, input.status, input.rawJson, input.savedVia, isPrimary ? 1 : 0],
    );
    const inserted = await this.first<{ id: number; saved_at: string | null }>(
      "SELECT id, saved_at FROM item_sources WHERE provider = ? AND item_kind IS ? AND provider_id = ?",
      [input.provider, input.itemKind, input.providerId],
    );
    if (!inserted) throw new Error("Failed to save item source");
    if (!inserted.saved_at) {
      await this.run(
        `UPDATE item_sources SET item_id = COALESCE(item_id, ?), url = ?, title = ?, status = ?, raw_json = ?,
           saved_at = datetime('now'), saved_via = ? WHERE id = ?`,
        [input.itemId, input.url, input.title, input.status, input.rawJson, input.savedVia, inserted.id],
      );
    }
    return { id: inserted.id, duplicate: !!inserted.saved_at };
  }

  /** Record a provider-owned identifier without marking it as user-saved. */
  private async recordItemSource(
    itemKind: ItemKind,
    itemId: number,
    provider: Provider,
    providerId: string | null | undefined,
    url?: string | null,
    primary = false,
  ): Promise<void> {
    if (!providerId) return;
    if (primary) {
      await this.run("UPDATE item_sources SET is_primary = 0 WHERE item_kind = ? AND item_id = ?", [itemKind, itemId]);
    }
    await this.run(
      `INSERT OR IGNORE INTO item_sources (item_kind, item_id, provider, provider_id, url, status, is_primary)
       VALUES (?, ?, ?, ?, ?, 'ok', ?)`,
      [itemKind, itemId, provider, providerId, url ?? null, primary ? 1 : 0],
    );
    await this.run(
      `UPDATE item_sources SET provider_id = ?, url = COALESCE(?, url), is_primary = ?
       WHERE item_kind = ? AND item_id = ? AND provider = ?`,
      [providerId, url ?? null, primary ? 1 : 0, itemKind, itemId, provider],
    );
  }

  /**
   * Bulk-insert legacy catalog rows (ids preserved so FKs line up). Per-row
   * try/catch so one bad row can't abort a batch. Does NOT enqueue enrichment
   * (legacy rows already carry mbid/cover_url where available).
   */
  async importChunk(payload: ImportPayload): Promise<{ artists: number; albums: number; tracks: number; trackArtists: number; skipped: number; failed: number }> {
    const p = this.normalizeMusicImport(payload);
    if (p.reset) await this.resetCatalog();
    const c = { artists: 0, albums: 0, tracks: 0, trackArtists: 0, skipped: 0, failed: 0 };
    const runBatch = async (statements: D1PreparedStatement[], key: "artists" | "albums" | "tracks" | "trackArtists") => {
      for (let i = 0; i < statements.length; i += 500) {
        try {
          const results = await this.env.DB.batch(statements.slice(i, i + 500));
          c[key] += results.filter((r) => Number(r.meta.changes ?? 0) > 0).length;
          c.skipped += results.filter((r) => Number(r.meta.changes ?? 0) === 0).length;
        } catch {
          c.failed += Math.min(500, statements.length - i);
        }
      }
    };
    const runStatements = async (statements: D1PreparedStatement[]) => {
      for (let i = 0; i < statements.length; i += 500) {
        await this.env.DB.batch(statements.slice(i, i + 500));
      }
    };
    await runBatch((p.artists ?? []).map((a) => this.stmt(
      "INSERT OR IGNORE INTO artists (id, name, normalized_name, artist_type, mbid, image_url, genres) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [a.id, a.name, a.normalized_name, artistType(a.artist_type), a.mbid ?? null, a.image_url ?? null, a.genres ?? null],
    )), "artists");
    await runBatch((p.albums ?? []).map((al) => this.stmt(
      "INSERT OR IGNORE INTO albums (id, title, normalized_title, artist_id, mbid, cover_url, year) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [al.id, al.title, al.normalized_title, al.artist_id ?? null, al.mbid ?? null, al.cover_url ?? null, al.year ?? null],
    )), "albums");
    await runBatch((p.tracks ?? []).map((t) => this.stmt(
      "INSERT OR IGNORE INTO tracks (id, title, normalized_title, artist_id, album_id, duration_ms, isrc, mbid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [t.id, t.title, t.normalized_title, t.artist_id ?? null, t.album_id ?? null, t.duration_ms ?? null, t.isrc ?? null, t.mbid ?? null],
    )), "tracks");
    await runBatch((p.trackArtists ?? []).map((ta) => this.stmt(
      "INSERT OR IGNORE INTO track_artists (track_id, artist_id, position, role) VALUES (?, ?, ?, ?)",
      [ta.track_id, ta.artist_id, ta.position ?? 0, ta.role ?? "main"],
    )), "trackArtists");
    const sourceStmt = (itemKind: ItemKind, itemId: number, provider: Provider, providerId: string | null | undefined, primary = false) =>
      providerId
        ? this.stmt(
            `INSERT OR IGNORE INTO item_sources (item_kind, item_id, provider, provider_id, status, is_primary)
             VALUES (?, ?, ?, ?, 'ok', ?)`,
            [itemKind, itemId, provider, providerId, primary ? 1 : 0],
          )
        : null;
    const sources = [
      ...(p.artists ?? []).map((a) => sourceStmt("artist", a.id, "musicbrainz", a.mbid, true)),
      ...(p.albums ?? []).map((al) => sourceStmt("album", al.id, "musicbrainz-release", al.mbid, true)),
      ...(p.tracks ?? []).flatMap((t) => [
        sourceStmt("track", t.id, "musicbrainz-recording", t.mbid, true),
        sourceStmt("track", t.id, "isrc", t.isrc),
      ]),
    ].filter((s): s is D1PreparedStatement => s !== null);
    await runStatements(sources);
    await runStatements([
      ...(p.artists ?? []).map((a) => this.stmt("INSERT OR IGNORE INTO enrich_queue (item_kind, item_id) VALUES ('artist', ?)", [a.id])),
      ...(p.albums ?? []).map((al) => this.stmt("INSERT OR IGNORE INTO enrich_queue (item_kind, item_id) VALUES ('album', ?)", [al.id])),
    ]);
    return c;
  }

  async repairCompoundArtists(limit = 100): Promise<CompoundArtistRepairResult> {
    const candidates = await this.all<{ id: number; name: string }>(
      `SELECT id, name FROM artists
       WHERE artist_type = 'musician'
         AND (name LIKE '%,%' OR name LIKE '% & %' OR name LIKE '%/%'
          OR name LIKE '% feat.%' OR name LIKE '% ft.%' OR name LIKE '% with %'
          OR name LIKE '% x %' OR name LIKE '% vs %')
       ORDER BY id
       LIMIT ?`,
      [Math.max(1, Math.min(500, Math.floor(limit)))],
    );
    const result = { processed: 0, repaired: 0, skipped: 0, failed: 0 };

    for (const artist of candidates) {
      result.processed++;
      const credits = splitArtists(artist.name);
      if (credits.length < 2) continue;
      try {
        const resolved = [];
        for (const credit of credits) {
          resolved.push({ ...credit, id: await this.getOrCreateArtist(credit.name) });
        }
        const primaryId = resolved[0]?.id;
        if (!primaryId) continue;

        const primaryTracks = await this.all<{ id: number }>("SELECT id FROM tracks WHERE artist_id = ?", [artist.id]);
        const explicitCredits = await this.all<{ track_id: number; position: number }>(
          "SELECT track_id, position FROM track_artists WHERE artist_id = ?",
          [artist.id],
        );
        for (const track of primaryTracks) {
          for (const [position, credit] of resolved.entries()) {
            await this.run(
              "INSERT OR IGNORE INTO track_artists (track_id, artist_id, position, role) VALUES (?, ?, ?, ?)",
              [track.id, credit.id, position, credit.role],
            );
          }
        }
        for (const existing of explicitCredits) {
          for (const [offset, credit] of resolved.entries()) {
            await this.run(
              "INSERT OR IGNORE INTO track_artists (track_id, artist_id, position, role) VALUES (?, ?, ?, ?)",
              [existing.track_id, credit.id, existing.position * 100 + offset, credit.role],
            );
          }
        }

        await this.run("UPDATE OR IGNORE albums SET artist_id = ? WHERE artist_id = ?", [primaryId, artist.id]);
        await this.run("UPDATE OR IGNORE tracks SET artist_id = ? WHERE artist_id = ?", [primaryId, artist.id]);
        const remaining = await this.first<{ albums: number; tracks: number }>(
          `SELECT
             (SELECT COUNT(*) FROM albums WHERE artist_id = ?) AS albums,
             (SELECT COUNT(*) FROM tracks WHERE artist_id = ?) AS tracks`,
          [artist.id, artist.id],
        );
        if (Number(remaining?.albums ?? 0) || Number(remaining?.tracks ?? 0)) {
          result.skipped++;
          continue;
        }
        await this.run("UPDATE OR IGNORE item_sources SET item_id = ? WHERE item_kind = 'artist' AND item_id = ?", [primaryId, artist.id]);
        await this.run("DELETE FROM track_artists WHERE artist_id = ?", [artist.id]);
        await this.run("DELETE FROM item_sources WHERE item_kind = 'artist' AND item_id = ?", [artist.id]);
        await this.run("DELETE FROM enrich_queue WHERE item_kind = 'artist' AND item_id = ?", [artist.id]);
        await this.run("DELETE FROM artists WHERE id = ?", [artist.id]);
        for (const credit of resolved) await this.enqueueEnrich("artist", credit.id);
        result.repaired++;
      } catch (error) {
        result.failed++;
        console.error("compound artist repair failed", artist.id, artist.name, error);
      }
    }
    return result;
  }

  // --- background enrichment ------------------------------------------------

  private async enqueueEnrich(itemKind: ItemKind, itemId: number): Promise<void> {
    await this.run("INSERT OR IGNORE INTO enrich_queue (item_kind, item_id) VALUES (?, ?)", [itemKind, itemId]);
  }

  /** Also enrich the artist/album that a saved track (or album) hangs off of. */
  private async enqueueRelated(itemKind: ItemKind, itemId: number): Promise<void> {
    if (itemKind === "track") {
      const t = await this.first<{ artist_id: number | null; album_id: number | null }>("SELECT artist_id, album_id FROM tracks WHERE id = ?", [itemId]);
      const artists = await this.all<{ artist_id: number }>("SELECT artist_id FROM track_artists WHERE track_id = ?", [itemId]);
      for (const artist of artists) await this.enqueueEnrich("artist", artist.artist_id);
      if (!artists.length && t?.artist_id) await this.enqueueEnrich("artist", t.artist_id);
      if (t?.album_id) await this.enqueueEnrich("album", t.album_id);
    } else if (itemKind === "album") {
      const al = await this.first<{ artist_id: number | null }>("SELECT artist_id FROM albums WHERE id = ?", [itemId]);
      if (al?.artist_id) await this.enqueueEnrich("artist", al.artist_id);
    }
  }

  /** Drain a few queued enrichment jobs. Call from explicit admin/maintenance routes. */
  async drainEnrichment(limit = 5): Promise<number> {
    let done = 0;
    // Skip items already tried this drain so a failing head item can't be
    // re-selected and burn through MAX_ATTEMPTS within a single run.
    const tried: number[] = [];
    let consecutiveFailures = 0;
    for (let i = 0; i < limit; i++) {
      const item = await this.first<{ id: number; item_kind: ItemKind; item_id: number; attempts: number }>(
        `SELECT id, item_kind, item_id, attempts
         FROM enrich_queue
         WHERE id NOT IN (${tried.map(() => "?").join(",") || "-1"})
         ORDER BY CASE
           WHEN item_kind IN ('movie', 'series', 'anime', 'manga', 'webtoon', 'comic') THEN 0
           WHEN item_kind = 'book' THEN 1
           WHEN item_kind = 'album' THEN 2
           WHEN item_kind = 'artist' THEN 3
           ELSE 4
         END, attempts, id
         LIMIT 1`,
        tried,
      );
      if (!item) break;
      tried.push(item.id);
      try {
        await this.enrichOne(item.item_kind, item.item_id);
        await this.run("DELETE FROM enrich_queue WHERE id = ?", [item.id]);
        done++;
        consecutiveFailures = 0;
      } catch (e) {
        console.error("enrich failed", item.item_kind, item.item_id, e);
        if (item.attempts + 1 >= MAX_ATTEMPTS) await this.run("DELETE FROM enrich_queue WHERE id = ?", [item.id]);
        else await this.run("UPDATE enrich_queue SET attempts = attempts + 1 WHERE id = ?", [item.id]);
        // A run of failures usually means an upstream provider outage; stop
        // instead of spending attempts across the whole queue.
        if (++consecutiveFailures >= 3) break;
      }
    }
    return done;
  }

  private async enrichOne(kind: ItemKind, id: number): Promise<void> {
    switch (kind) {
      case "artist":
        return this.enrichArtistRow(id);
      case "album":
        return this.enrichAlbumRow(id);
      case "track":
        return this.enrichTrackRow(id);
      case "book":
        return this.enrichBookRow(id);
      default:
        if (isVisualKind(kind)) return this.enrichMediaRow(id);
    }
  }

  private async enrichArtistRow(id: number): Promise<void> {
    const row = await this.first<{ name: string; artist_type: ArtistType; image_url: string | null; image_key: string | null }>("SELECT name, artist_type, image_url, image_key FROM artists WHERE id = ?", [id]);
    if (!row) return;
    if (row.artist_type !== "musician") {
      await this.run("UPDATE artists SET enriched_at = datetime('now') WHERE id = ?", [id]);
      return;
    }
    const [res, deezer] = await Promise.all([
      mb.enrichArtist(row.name).catch(() => null),
      row.image_url ? Promise.resolve(null) : findDeezerArtist(row.name).catch(() => null),
    ]);
    let imageKey = row.image_key;
    const imageUrl = row.image_url ?? deezer?.imageUrl ?? null;
    if (!imageKey && imageUrl) imageKey = await cacheImage(this.env, imageUrl, `artist/${id}`);
    await this.run(
      "UPDATE artists SET mbid = COALESCE(mbid, ?), genres = COALESCE(genres, ?), image_url = COALESCE(image_url, ?), image_key = COALESCE(image_key, ?), enriched_at = datetime('now') WHERE id = ?",
      [res?.mbid ?? null, res?.genres ?? null, imageUrl, imageKey ?? null, id],
    );
    await this.recordItemSource("artist", id, "musicbrainz", res?.mbid, null, true);
    await this.recordItemSource("artist", id, deezer?.provider ?? "deezer-artist", deezer?.id);
  }

  private async enrichAlbumRow(id: number): Promise<void> {
    const row = await this.first<{ title: string; cover_url: string | null; cover_key: string | null; artist: string | null }>(
      "SELECT al.title, al.cover_url, al.cover_key, a.name AS artist FROM albums al LEFT JOIN artists a ON a.id = al.artist_id WHERE al.id = ?",
      [id],
    );
    if (!row) return;
    const [res, deezer] = await Promise.all([
      mb.enrichRelease(row.title, row.artist ?? "").catch(() => null),
      row.cover_url ? Promise.resolve(null) : findDeezerAlbum(row.title, row.artist ?? "").catch(() => null),
    ]);
    let coverUrl = row.cover_url;
    if (!coverUrl && res?.mbid) coverUrl = mb.coverArtUrl(res.mbid);
    if (!coverUrl) coverUrl = deezer?.imageUrl ?? null;
    let coverKey = row.cover_key;
    if (!coverKey && coverUrl) coverKey = await cacheImage(this.env, coverUrl, `album/${id}`);
    await this.run(
      "UPDATE albums SET mbid = COALESCE(mbid, ?), year = COALESCE(year, ?), cover_url = COALESCE(cover_url, ?), cover_key = COALESCE(cover_key, ?), enriched_at = datetime('now') WHERE id = ?",
      [res?.mbid ?? null, res?.year ?? deezer?.year ?? null, coverUrl ?? null, coverKey ?? null, id],
    );
    await this.recordItemSource("album", id, "musicbrainz-release", res?.mbid, null, true);
    await this.recordItemSource("album", id, deezer?.provider ?? "deezer-album", deezer?.id);
  }

  private async enrichTrackRow(id: number): Promise<void> {
    const row = await this.first<{ title: string; isrc: string | null; artist: string | null }>(
      "SELECT t.title, t.isrc, a.name AS artist FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.id = ?",
      [id],
    );
    if (!row) return;
    const res = await mb.enrichRecording(row.title, row.artist ?? "");
    await this.run(
      "UPDATE tracks SET mbid = COALESCE(mbid, ?), isrc = COALESCE(isrc, ?) WHERE id = ?",
      [res?.mbid ?? null, res?.isrc ?? null, id],
    );
    await this.recordItemSource("track", id, "musicbrainz-recording", res?.mbid, null, true);
    await this.recordItemSource("track", id, "isrc", res?.isrc);
  }

  private async enrichBookRow(id: number): Promise<void> {
    const row = await this.first<{ title: string; isbn: string | null; cover_url: string | null; cover_key: string | null; author: string | null }>(
      `SELECT b.title, b.isbn, b.cover_url, b.cover_key,
              (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id ORDER BY ba.position LIMIT 1) AS author
       FROM books b WHERE b.id = ?`,
      [id],
    );
    if (!row) return;
    const res = await enrichBook({ title: row.title, author: row.author ?? "Unknown", isbn: row.isbn ?? undefined });
    let coverUrl = row.cover_url ?? res?.coverUrl ?? null;
    let coverKey = row.cover_key;
    if (!coverKey && coverUrl) coverKey = await cacheImage(this.env, coverUrl, `book/${id}`);
    await this.run(
      `UPDATE books SET olid = COALESCE(olid, ?), isbn = COALESCE(isbn, ?), page_count = COALESCE(page_count, ?), year = COALESCE(year, ?),
                        cover_url = COALESCE(cover_url, ?), cover_key = COALESCE(cover_key, ?), enriched_at = datetime('now') WHERE id = ?`,
      [res?.olid ?? null, res?.isbn ?? null, res?.pageCount ?? null, res?.year ?? null, coverUrl, coverKey ?? null, id],
    );
    await this.recordItemSource("book", id, "openlibrary", res?.olid, res?.olid ? `https://openlibrary.org/works/${res.olid}` : null, true);
    await this.recordItemSource("book", id, "isbn", row.isbn ?? res?.isbn);
  }

  private async enrichMediaRow(id: number): Promise<void> {
    const row = await this.first<{ kind: VisualKind; title: string; year: number | null; cover_url: string | null; cover_key: string | null }>(
      "SELECT kind, title, year, cover_url, cover_key FROM media_items WHERE id = ?", [id],
    );
    if (!row) return;
    const source = row.kind === "anime" || row.kind === "manga"
      ? await this.first<{ provider_id: string }>(
          "SELECT provider_id FROM item_sources WHERE item_kind = ? AND item_id = ? AND provider = 'myanimelist' ORDER BY is_primary DESC LIMIT 1",
          [row.kind, id],
        )
      : null;
    const match = row.kind === "anime" || row.kind === "manga"
      ? source?.provider_id ? await findJikanMedia(row.kind, source.provider_id) : null
      : row.kind === "movie" || row.kind === "series"
        ? await findTmdbMedia(row.kind, row.title, row.year, this.env.TMDB_API_TOKEN)
        : null;
    const coverUrl = row.cover_url ?? match?.imageUrl ?? null;
    let coverKey = row.cover_key;
    if (!coverKey && coverUrl) coverKey = await cacheImage(this.env, coverUrl, `media/${id}`);
    await this.run(
      "UPDATE media_items SET year = COALESCE(year, ?), description = COALESCE(description, ?), cover_url = COALESCE(cover_url, ?), cover_key = COALESCE(cover_key, ?), enriched_at = datetime('now') WHERE id = ?",
      [match?.year ?? null, match?.description ?? null, coverUrl, coverKey ?? null, id],
    );
    if (match) await this.recordItemSource(row.kind, id, match.provider, match.id, match.url, true);
  }

  private async upsertEntity(f: Fetched): Promise<{ itemKind: ItemKind; itemId: number; title: string }> {
    switch (f.kind) {
      case "artist": {
        const id = await this.getOrCreateArtist(f.name, f.imageUrl, f.artistType);
        return { itemKind: "artist", itemId: id, title: f.name };
      }
      case "album": {
        const artistId = await this.getOrCreateArtist(f.artist);
        const id = await this.getOrCreateAlbum(f.title, artistId, { year: f.year, coverUrl: f.coverUrl });
        return { itemKind: "album", itemId: id, title: f.title };
      }
      case "track": {
        const id = await this.upsertTrack(f);
        return { itemKind: "track", itemId: id, title: f.title };
      }
      case "book": {
        const id = await this.getOrCreateBook(f);
        return { itemKind: "book", itemId: id, title: f.title };
      }
      default: {
        const id = await this.getOrCreateMedia(f);
        return { itemKind: f.kind, itemId: id, title: f.title };
      }
    }
  }

  private async getOrCreateAuthor(name: string): Promise<number> {
    const norm = normalize(name);
    const row = await this.first<{ id: number }>("SELECT id FROM authors WHERE normalized_name = ?", [norm]);
    if (row) return row.id;
    return Number(await this.scalar("INSERT INTO authors (name, normalized_name) VALUES (?, ?) RETURNING id AS value", [name, norm]));
  }

  private async getOrCreateBook(f: FetchedBook): Promise<number> {
    const norm = normalize(f.title);
    let row: { id: number } | null = null;
    if (f.isbn) row = await this.first<{ id: number }>("SELECT id FROM books WHERE isbn = ?", [f.isbn]);
    if (!row) row = await this.first<{ id: number }>("SELECT id FROM books WHERE normalized_title = ? AND isbn IS NULL", [norm]);

    let bookId: number;
    if (row) {
      bookId = row.id;
      await this.run(
        `UPDATE books SET isbn = COALESCE(isbn, ?), year = COALESCE(year, ?), page_count = COALESCE(page_count, ?),
                          cover_url = COALESCE(cover_url, ?), description = COALESCE(description, ?) WHERE id = ?`,
        [f.isbn ?? null, f.year ?? null, f.pageCount ?? null, f.coverUrl ?? null, f.description ?? null, bookId],
      );
    } else {
      bookId = Number(
        await this.scalar(
          `INSERT INTO books (title, normalized_title, isbn, year, page_count, cover_url, description, reading_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'want') RETURNING id AS value`,
          [f.title, norm, f.isbn ?? null, f.year ?? null, f.pageCount ?? null, f.coverUrl ?? null, f.description ?? null],
        ),
      );
    }

    for (const [i, name] of f.author.split(/,\s*/).entries()) {
      if (!name.trim()) continue;
      const authorId = await this.getOrCreateAuthor(name.trim());
      await this.run("INSERT OR IGNORE INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)", [bookId, authorId, i]);
    }
    return bookId;
  }

  private async getOrCreateMedia(f: FetchedVisual): Promise<number> {
    const norm = normalize(f.title);
    const row = await this.first<{ id: number }>("SELECT id FROM media_items WHERE kind = ? AND normalized_title = ?", [f.kind, norm]);

    if (row) {
      await this.run(
        `UPDATE media_items SET year = COALESCE(year, ?), cover_url = COALESCE(cover_url, ?),
           description = COALESCE(description, ?) WHERE id = ?`,
        [f.year ?? null, f.coverUrl ?? null, f.description ?? null, row.id],
      );
      return row.id;
    }

    return Number(
      await this.scalar(
        `INSERT INTO media_items (kind, title, normalized_title, year, cover_url, description)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id AS value`,
        [f.kind, f.title, norm, f.year ?? null, f.coverUrl ?? null, f.description ?? null],
      ),
    );
  }

  private async getOrCreateArtist(name: string, imageUrl?: string, inputArtistType: ArtistType = "musician"): Promise<number> {
    const norm = normalize(name);
    const row = await this.first<{ id: number }>("SELECT id FROM artists WHERE normalized_name = ?", [norm]);
    if (row) {
      if (imageUrl) await this.run("UPDATE artists SET image_url = COALESCE(image_url, ?) WHERE id = ?", [imageUrl, row.id]);
      return row.id;
    }
    return Number(
      await this.scalar("INSERT INTO artists (name, normalized_name, artist_type, image_url) VALUES (?, ?, ?, ?) RETURNING id AS value", [name, norm, artistType(inputArtistType), imageUrl ?? null]),
    );
  }

  private async getOrCreateAlbum(title: string, artistId: number, extra: { year?: number; coverUrl?: string } = {}): Promise<number> {
    const norm = normalize(title);
    const row = await this.first<{ id: number }>("SELECT id FROM albums WHERE normalized_title = ? AND artist_id = ?", [norm, artistId]);
    if (row) {
      await this.run(
        "UPDATE albums SET year = COALESCE(year, ?), cover_url = COALESCE(cover_url, ?) WHERE id = ?",
        [extra.year ?? null, extra.coverUrl ?? null, row.id],
      );
      return row.id;
    }
    return Number(
      await this.scalar(
        "INSERT INTO albums (title, normalized_title, artist_id, year, cover_url) VALUES (?, ?, ?, ?, ?) RETURNING id AS value",
        [title, norm, artistId, extra.year ?? null, extra.coverUrl ?? null],
      ),
    );
  }

  private async upsertTrack(f: { title: string; artist: string; album?: string; year?: number; durationMs?: number; coverUrl?: string }): Promise<number> {
    const artists = splitArtists(f.artist);
    const primaryId = await this.getOrCreateArtist(artists[0]?.name ?? f.artist);
    const norm = normalize(f.title);

    let albumId: number | null = null;
    if (f.album) albumId = await this.getOrCreateAlbum(f.album, primaryId, { year: f.year, coverUrl: f.coverUrl });

    let row = await this.first<{ id: number }>("SELECT id FROM tracks WHERE normalized_title = ? AND artist_id = ?", [norm, primaryId]);
    let trackId: number;
    if (row) {
      trackId = row.id;
      await this.run(
        "UPDATE tracks SET album_id = COALESCE(album_id, ?), duration_ms = COALESCE(duration_ms, ?) WHERE id = ?",
        [albumId, f.durationMs ?? null, trackId],
      );
    } else {
      trackId = Number(
        await this.scalar(
          "INSERT INTO tracks (title, normalized_title, artist_id, album_id, duration_ms) VALUES (?, ?, ?, ?, ?) RETURNING id AS value",
          [f.title, norm, primaryId, albumId, f.durationMs ?? null],
        ),
      );
    }

    // Link every contributing artist (main/featured) for disaggregated browsing.
    for (const [i, a] of artists.entries()) {
      const aid = await this.getOrCreateArtist(a.name);
      await this.run(
        "INSERT OR IGNORE INTO track_artists (track_id, artist_id, position, role) VALUES (?, ?, ?, ?)",
        [trackId, aid, i, a.role],
      );
    }
    return trackId;
  }

  private normalizeMusicImport(p: ImportPayload): ImportPayload {
    const artists = p.artists ?? [];
    if (!artists.length) return p;

    const maxArtistId = artists.reduce((max, artist) => Math.max(max, artist.id), 0);
    let nextArtistId = maxArtistId + 1;
    const artistIdByNorm = new Map<string, number>();
    const creditsByOriginalId = new Map<number, { id: number; name: string; role: string }[]>();
    const outArtists: ImportArtist[] = [];

    const addArtist = (artist: ImportArtist) => {
      const norm = normalize(artist.name);
      const existingId = artistIdByNorm.get(norm);
      if (existingId) return existingId;
      const row = { ...artist, normalized_name: norm };
      artistIdByNorm.set(norm, row.id);
      outArtists.push(row);
      return row.id;
    };

    for (const artist of artists) {
      const credits = splitArtists(artist.name);
      if (credits.length === 1 && normalize(credits[0]?.name ?? "") === normalize(artist.name)) {
        const id = addArtist(artist);
        creditsByOriginalId.set(artist.id, [{ id, name: artist.name, role: "main" }]);
      }
    }

    for (const artist of artists) {
      if (creditsByOriginalId.has(artist.id)) continue;
      const credits = splitArtists(artist.name);
      const resolved = credits.map((credit, index) => {
        const norm = normalize(credit.name);
        let id = artistIdByNorm.get(norm);
        if (!id) {
          id = addArtist({
            id: index === 0 ? artist.id : nextArtistId++,
            name: credit.name,
            normalized_name: norm,
          });
        }
        return { id, name: credit.name, role: credit.role };
      });
      creditsByOriginalId.set(artist.id, resolved);
    }

    const primaryArtistId = (artistId?: number | null) => artistId ? creditsByOriginalId.get(artistId)?.[0]?.id ?? artistId : artistId;
    const expandedTrackArtists: ImportTrackArtist[] = [];
    const tracksWithExplicitArtists = new Set<number>();

    for (const ta of p.trackArtists ?? []) {
      tracksWithExplicitArtists.add(ta.track_id);
      const credits = creditsByOriginalId.get(ta.artist_id);
      if (!credits?.length) {
        expandedTrackArtists.push(ta);
        continue;
      }
      for (const [offset, credit] of credits.entries()) {
        expandedTrackArtists.push({
          ...ta,
          artist_id: credit.id,
          position: (ta.position ?? 0) * 100 + offset,
          role: ta.role ?? credit.role,
        });
      }
    }

    for (const track of p.tracks ?? []) {
      if (tracksWithExplicitArtists.has(track.id) || !track.artist_id) continue;
      const credits = creditsByOriginalId.get(track.artist_id);
      if (!credits?.length) continue;
      for (const [position, credit] of credits.entries()) {
        expandedTrackArtists.push({ track_id: track.id, artist_id: credit.id, position, role: credit.role });
      }
    }

    return {
      ...p,
      artists: outArtists,
      albums: p.albums?.map((album) => ({ ...album, artist_id: primaryArtistId(album.artist_id) })),
      tracks: p.tracks?.map((track) => ({ ...track, artist_id: primaryArtistId(track.artist_id) })),
      trackArtists: expandedTrackArtists,
    };
  }
}
