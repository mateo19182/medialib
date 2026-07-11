import type { Env, LibraryStats } from "../types";
import { classify, fetchMetadata } from "../ingest";
import type { Fetched } from "../ingest";
import type { ArtistType, Classified, FetchedBook, FetchedMedia, MediaKind } from "../ingest/types";
import { normalize, splitArtists } from "../util";
import * as mb from "../enrich/musicbrainz";
import { enrichBook } from "../enrich/openlibrary";
import { findDeezerAlbum, findDeezerArtist, findJikanMedia, findTmdbMedia } from "../enrich/visual";
import { cacheImage } from "../r2";
import { isTextAddKind, resolveText, type TextAddKind } from "../ingest/text";
import type { LiveShow } from "../live-shows";

const MAX_ATTEMPTS = 3;

const splitLines = (value?: string) => (value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
const splitComma = (value?: string) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const parseStringList = (value: unknown): string[] => {
  try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
};
const ARTIST_TYPE_SET = new Set<ArtistType>(["musician", "visual_artist", "filmmaker", "writer", "performer", "other"]);
const artistType = (value: unknown): ArtistType => ARTIST_TYPE_SET.has(value as ArtistType) ? value as ArtistType : "musician";

export interface SaveResult {
  ok: boolean;
  duplicate?: boolean;
  linkId?: number;
  status?: string;
  entityType?: string | null;
  title?: string;
  error?: string;
}

export interface CompoundArtistRepairResult {
  processed: number;
  repaired: number;
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
  source: string;
  source_kind: string | null;
  entity_type: string | null;
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
  kind: MediaKind;
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
  source: string | null;
  source_id: string | null;
  source_url: string | null;
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
      (SELECT COUNT(*) FROM links) AS links,
      (SELECT COUNT(*) FROM enrich_queue) AS pending`);
    return row ?? { tracks: 0, artists: 0, albums: 0, books: 0, movies: 0, series: 0, anime: 0, manga: 0, links: 0, pending: 0 };
  }

  recent(limit = 20): Promise<RecentLink[]> {
    return this.all<RecentLink>(
      "SELECT id, url, source, source_kind, entity_type, title, status, saved_at, saved_via FROM links ORDER BY saved_at DESC, id DESC LIMIT ?",
      [limit],
    );
  }

  /** Artists that have at least one album or track, with counts, for /library. */
  listArtists(limit = 50, offset = 0): Promise<PageResult<ArtistSummary>> {
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
       ORDER BY a.name COLLATE NOCASE`;
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
  listAlbums(limit = 50, offset = 0): Promise<PageResult<AlbumRow>> {
    return this.page<AlbumRow>(
      `SELECT al.id, al.title, al.year, al.cover_url, al.cover_key, al.rating,
              al.artist_id, a.name AS artist,
              (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS tracks
       FROM albums al
       LEFT JOIN artists a ON a.id = al.artist_id
       ORDER BY al.title COLLATE NOCASE`, "SELECT COUNT(*) AS value FROM albums", [], limit, offset,
    );
  }

  /** Tracks with album and disaggregated artist display, for the music track view. */
  listTracks(limit = 50, offset = 0): Promise<PageResult<TrackRow>> {
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
       ORDER BY t.title COLLATE NOCASE`, "SELECT COUNT(*) AS value FROM tracks", [], limit, offset,
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
  listBooks(limit = 50, offset = 0): Promise<PageResult<BookRow>> {
    return this.page<BookRow>(
      `SELECT b.id, b.title, b.cover_url, b.cover_key, b.year, b.reading_status,
              (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
               WHERE ba.book_id = b.id ORDER BY ba.position LIMIT 1) AS author
       FROM books b ORDER BY b.title COLLATE NOCASE`, "SELECT COUNT(*) AS value FROM books", [], limit, offset,
    );
  }

  /** Visual media by category, for /movies, /series, /anime, /manga. */
  listMedia(kind: MediaKind, limit = 50, offset = 0): Promise<PageResult<MediaRow>> {
    return this.page<MediaRow>(
      `SELECT id, kind, title, cover_url, cover_key, year, rating,
              media_format, list_status, progress_current, progress_total, personal_score
       FROM media_items WHERE kind = ? ORDER BY title COLLATE NOCASE`,
      "SELECT COUNT(*) AS value FROM media_items WHERE kind = ?", [kind], limit, offset,
    );
  }

  mediaDetail(id: number): Promise<MediaDetail | null> {
    return this.first<MediaDetail>(
      `SELECT id, kind, title, source, source_id, source_url, cover_url, cover_key, year, description, rating,
              media_format, list_status, progress_current, progress_total, personal_score, notes, tags
       FROM media_items WHERE id = ?`,
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
    const row = await this.first<{ image_key: string | null; entity_type: string }>(
      `SELECT ${imageColumn ? imageColumn : "NULL"} AS image_key, ${kind === "media" ? "kind" : `'${kind}'`} AS entity_type FROM ${table} WHERE id = ?`,
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
      this.stmt("DELETE FROM links WHERE entity_type = ? AND entity_id = ?", [row.entity_type, id]),
      this.stmt("DELETE FROM external_ids WHERE entity_type = ? AND entity_id = ?", [row.entity_type, id]),
      this.stmt("DELETE FROM enrich_queue WHERE entity_type = ? AND entity_id = ?", [kind === "media" ? "media" : kind, id]),
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

  /** Fuzzy search across music, books, movies, series, anime, and manga. */
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
  async saveLink(url: string, via: "web" | "telegram" | "linkwarden" = "web"): Promise<SaveResult> {
    const c = classify(url);
    if (!c) return { ok: false, error: "Unrecognized link" };

    const existing = await this.first<{ id: number; title: string | null; status: string; entity_type: string | null }>(
      "SELECT id, title, status, entity_type FROM links WHERE source = ? AND source_kind = ? AND source_id = ?",
      [c.source, c.kind, c.sourceId],
    );
    if (existing) {
      return {
        ok: true,
        duplicate: true,
        linkId: existing.id,
        status: existing.status,
        entityType: existing.entity_type,
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

    let entityType: string | null = null;
    let entityId: number | null = null;
    let title = url;
    if (fetched) {
      const up = await this.upsertEntity(fetched, c);
      entityType = up.entityType;
      entityId = up.entityId;
      title = up.title;
      await this.enqueueEnrich(up.enrichType ?? entityType, entityId);
      await this.enqueueRelated(entityType, entityId);
    }
    const status = fetched ? "ok" : error ? "error" : "pending";

    let linkId: number;
    try {
      linkId = Number(
        await this.scalar(
          `INSERT INTO links (url, source, source_kind, source_id, entity_type, entity_id, title, status, raw_json, saved_via)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id AS value`,
          [url, c.source, c.kind, c.sourceId, entityType, entityId, title, status, JSON.stringify(fetched ?? (error ? { error } : {})), via],
        ),
      );
    } catch {
      // Lost a race on the UNIQUE(source, source_kind, source_id) constraint — treat as dup.
      const dup = await this.first<{ id: number; title: string | null; status: string }>(
        "SELECT id, title, status FROM links WHERE source = ? AND source_kind = ? AND source_id = ?",
        [c.source, c.kind, c.sourceId],
      );
      return { ok: true, duplicate: true, linkId: dup?.id, status: dup?.status, title: dup?.title ?? url };
    }

    return { ok: true, linkId, status, entityType, title, error };
  }

  /** Save a name entered by a user, resolving it against a public catalogue when possible. */
  async saveText(kind: TextAddKind, text: string, via: "web" | "telegram" = "telegram", creator = "", inputArtistType: ArtistType = "musician"): Promise<SaveResult> {
    const query = text.trim();
    if (!query) return { ok: false, error: "Enter a title or name" };
    const creatorName = creator.trim();
    const requestedArtistType = artistType(inputArtistType);
    let resolved;
    let error: string | undefined;
    try {
      resolved = kind === "artist" && requestedArtistType !== "musician" ? null : await resolveText(kind, query, this.env.TMDB_API_TOKEN, creatorName);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    const fallback: Fetched = kind === "artist" ? { entityType: "artist", name: query, artistType: requestedArtistType }
      : kind === "album" ? { entityType: "album", title: query, artist: creatorName || "Unknown" }
      : kind === "track" ? { entityType: "track", title: query, artist: creatorName || "Unknown" }
      : kind === "book" ? { entityType: "book", title: query, author: creatorName || "Unknown" }
      : { entityType: "media", kind, title: query };
    const source = resolved?.source ?? "manual";
    const sourceId = resolved?.sourceId ?? `${kind}:${normalize(query)}:${normalize(creatorName)}:${kind === "artist" ? requestedArtistType : ""}`;
    const url = resolved?.url ?? `text:${encodeURIComponent(query)}`;
    const existing = await this.first<{ id: number; title: string | null; status: string; entity_type: string | null }>(
      "SELECT id, title, status, entity_type FROM links WHERE source = ? AND source_kind = ? AND source_id = ?", [source, kind, sourceId],
    );
    if (existing) return { ok: true, duplicate: true, linkId: existing.id, status: existing.status, entityType: existing.entity_type, title: existing.title ?? query };
    const fetched = resolved?.fetched ?? fallback;
    const up = await this.upsertEntity(fetched, { source, sourceId, url });
    if (!(fetched.entityType === "artist" && artistType(fetched.artistType) !== "musician")) await this.enqueueEnrich(up.enrichType ?? up.entityType, up.entityId);
    await this.enqueueRelated(up.entityType, up.entityId);
    const status = resolved ? "ok" : "pending";
    const linkId = Number(await this.scalar(
      `INSERT INTO links (url, source, source_kind, source_id, entity_type, entity_id, title, status, raw_json, saved_via)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id AS value`,
      [url, source, kind, sourceId, up.entityType, up.entityId, up.title, status, JSON.stringify(resolved?.fetched ?? { query, error: error ?? "No catalogue match" }), via],
    ));
    return { ok: true, linkId, status, entityType: up.entityType, title: up.title, error: error ?? (resolved ? undefined : "No catalogue match") };
  }

  async setTelegramAddKind(chatId: number, userId: number, kind: TextAddKind): Promise<void> {
    await this.kvSet(`telegram:add:${chatId}:${userId}`, kind);
  }

  async takeTelegramAddKind(chatId: number, userId: number): Promise<TextAddKind | null> {
    const key = `telegram:add:${chatId}:${userId}`;
    const value = await this.kvGet(key);
    if (value) await this.run("DELETE FROM kv WHERE key = ?", [key]);
    return isTextAddKind(value) ? value : null;
  }

  // --- bulk import (migration from the legacy SQLite catalog) --------------

  async resetCatalog(): Promise<void> {
    for (const t of ["track_artists", "tracks", "albums", "artists", "book_authors", "books", "authors", "media_items", "links", "enrich_queue"]) {
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

  /** Record a provider-owned identifier without replacing the original source. */
  private async recordExternalId(
    entityType: string,
    entityId: number,
    provider: string,
    externalId: string | null | undefined,
    externalUrl?: string | null,
    primary = false,
  ): Promise<void> {
    if (!externalId) return;
    if (primary) {
      await this.run("UPDATE external_ids SET is_primary = 0 WHERE entity_type = ? AND entity_id = ?", [entityType, entityId]);
    }
    await this.run(
      `INSERT INTO external_ids (entity_type, entity_id, provider, external_id, external_url, is_primary)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id, provider) DO UPDATE SET
         external_id = excluded.external_id,
         external_url = COALESCE(excluded.external_url, external_ids.external_url),
         is_primary = excluded.is_primary`,
      [entityType, entityId, provider, externalId, externalUrl ?? null, primary ? 1 : 0],
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
    const externalIdStmt = (entityType: string, entityId: number, provider: string, externalId: string | null | undefined, primary = false) =>
      externalId
        ? this.stmt(
            `INSERT INTO external_ids (entity_type, entity_id, provider, external_id, is_primary)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(entity_type, entity_id, provider) DO UPDATE SET external_id = excluded.external_id, is_primary = excluded.is_primary`,
            [entityType, entityId, provider, externalId, primary ? 1 : 0],
          )
        : null;
    const externalIds = [
      ...(p.artists ?? []).map((a) => externalIdStmt("artist", a.id, "musicbrainz", a.mbid, true)),
      ...(p.albums ?? []).map((al) => externalIdStmt("album", al.id, "musicbrainz-release", al.mbid, true)),
      ...(p.tracks ?? []).flatMap((t) => [
        externalIdStmt("track", t.id, "musicbrainz-recording", t.mbid, true),
        externalIdStmt("track", t.id, "isrc", t.isrc),
      ]),
    ].filter((s): s is D1PreparedStatement => s !== null);
    await runStatements(externalIds);
    await runStatements([
      ...(p.artists ?? []).map((a) => this.stmt("INSERT OR IGNORE INTO enrich_queue (entity_type, entity_id) VALUES ('artist', ?)", [a.id])),
      ...(p.albums ?? []).map((al) => this.stmt("INSERT OR IGNORE INTO enrich_queue (entity_type, entity_id) VALUES ('album', ?)", [al.id])),
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
    const result = { processed: 0, repaired: 0, failed: 0 };

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
        await this.run("UPDATE links SET entity_id = ? WHERE entity_type = 'artist' AND entity_id = ?", [primaryId, artist.id]);
        await this.run("DELETE FROM track_artists WHERE artist_id = ?", [artist.id]);
        await this.run("DELETE FROM external_ids WHERE entity_type = 'artist' AND entity_id = ?", [artist.id]);
        await this.run("DELETE FROM enrich_queue WHERE entity_type = 'artist' AND entity_id = ?", [artist.id]);
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

  private async enqueueEnrich(entityType: string, entityId: number): Promise<void> {
    await this.run("INSERT OR IGNORE INTO enrich_queue (entity_type, entity_id) VALUES (?, ?)", [entityType, entityId]);
  }

  /** Also enrich the artist/album that a saved track (or album) hangs off of. */
  private async enqueueRelated(entityType: string, entityId: number): Promise<void> {
    if (entityType === "track") {
      const t = await this.first<{ artist_id: number | null; album_id: number | null }>("SELECT artist_id, album_id FROM tracks WHERE id = ?", [entityId]);
      const artists = await this.all<{ artist_id: number }>("SELECT artist_id FROM track_artists WHERE track_id = ?", [entityId]);
      for (const artist of artists) await this.enqueueEnrich("artist", artist.artist_id);
      if (!artists.length && t?.artist_id) await this.enqueueEnrich("artist", t.artist_id);
      if (t?.album_id) await this.enqueueEnrich("album", t.album_id);
    } else if (entityType === "album") {
      const al = await this.first<{ artist_id: number | null }>("SELECT artist_id FROM albums WHERE id = ?", [entityId]);
      if (al?.artist_id) await this.enqueueEnrich("artist", al.artist_id);
    }
  }

  /** Drain a few queued enrichment jobs. Call from explicit admin/maintenance routes. */
  async drainEnrichment(limit = 5): Promise<number> {
    let done = 0;
    for (let i = 0; i < limit; i++) {
      const item = await this.first<{ id: number; entity_type: string; entity_id: number; attempts: number }>(
        `SELECT id, entity_type, entity_id, attempts
         FROM enrich_queue
         ORDER BY CASE entity_type
           WHEN 'media' THEN 0
           WHEN 'book' THEN 1
           WHEN 'album' THEN 2
           WHEN 'artist' THEN 3
           ELSE 4
         END, id
         LIMIT 1`,
      );
      if (!item) break;
      try {
        await this.enrichOne(item.entity_type, item.entity_id);
        await this.run("DELETE FROM enrich_queue WHERE id = ?", [item.id]);
        done++;
      } catch (e) {
        console.error("enrich failed", item.entity_type, item.entity_id, e);
        if (item.attempts + 1 >= MAX_ATTEMPTS) await this.run("DELETE FROM enrich_queue WHERE id = ?", [item.id]);
        else await this.run("UPDATE enrich_queue SET attempts = attempts + 1 WHERE id = ?", [item.id]);
      }
    }
    return done;
  }

  private async enrichOne(type: string, id: number): Promise<void> {
    switch (type) {
      case "artist":
        return this.enrichArtistRow(id);
      case "album":
        return this.enrichAlbumRow(id);
      case "track":
        return this.enrichTrackRow(id);
      case "book":
        return this.enrichBookRow(id);
      case "media":
        return this.enrichMediaRow(id);
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
    await this.recordExternalId("artist", id, "musicbrainz", res?.mbid, null, true);
    await this.recordExternalId("artist", id, deezer?.provider ?? "deezer-artist", deezer?.id);
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
    await this.recordExternalId("album", id, "musicbrainz-release", res?.mbid, null, true);
    await this.recordExternalId("album", id, deezer?.provider ?? "deezer-album", deezer?.id);
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
    await this.recordExternalId("track", id, "musicbrainz-recording", res?.mbid, null, true);
    await this.recordExternalId("track", id, "isrc", res?.isrc);
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
      `UPDATE books SET olid = COALESCE(olid, ?), page_count = COALESCE(page_count, ?), year = COALESCE(year, ?),
                        cover_url = COALESCE(cover_url, ?), cover_key = COALESCE(cover_key, ?), enriched_at = datetime('now') WHERE id = ?`,
      [res?.olid ?? null, res?.pageCount ?? null, res?.year ?? null, coverUrl, coverKey ?? null, id],
    );
    await this.recordExternalId("book", id, "openlibrary", res?.olid, res?.olid ? `https://openlibrary.org/books/${res.olid}` : null, true);
    await this.recordExternalId("book", id, "isbn", row.isbn);
  }

  private async enrichMediaRow(id: number): Promise<void> {
    const row = await this.first<{ kind: MediaKind; title: string; year: number | null; source: string | null; source_id: string | null; cover_url: string | null; cover_key: string | null }>(
      "SELECT kind, title, year, source, source_id, cover_url, cover_key FROM media_items WHERE id = ?", [id],
    );
    if (!row) return;
    const match = row.kind === "anime" || row.kind === "manga"
      ? row.source === "myanimelist" && row.source_id ? await findJikanMedia(row.kind, row.source_id) : null
      : await findTmdbMedia(row.kind, row.title, row.year, this.env.TMDB_API_TOKEN);
    const coverUrl = row.cover_url ?? match?.imageUrl ?? null;
    let coverKey = row.cover_key;
    if (!coverKey && coverUrl) coverKey = await cacheImage(this.env, coverUrl, `media/${id}`);
    await this.run(
      "UPDATE media_items SET year = COALESCE(year, ?), description = COALESCE(description, ?), cover_url = COALESCE(cover_url, ?), cover_key = COALESCE(cover_key, ?), enriched_at = datetime('now') WHERE id = ?",
      [match?.year ?? null, match?.description ?? null, coverUrl, coverKey ?? null, id],
    );
    if (match) await this.recordExternalId(row.kind, id, match.provider, match.id, match.url, true);
  }

  private async upsertEntity(f: Fetched, c: { source: string; sourceId: string; url: string }): Promise<{ entityType: string; entityId: number; title: string; enrichType?: string }> {
    switch (f.entityType) {
      case "artist": {
        const id = await this.getOrCreateArtist(f.name, f.imageUrl, f.artistType);
        await this.recordExternalId("artist", id, c.source, c.sourceId, c.url, true);
        return { entityType: "artist", entityId: id, title: f.name };
      }
      case "album": {
        const artistId = await this.getOrCreateArtist(f.artist);
        const id = await this.getOrCreateAlbum(f.title, artistId, { year: f.year, coverUrl: f.coverUrl });
        await this.recordExternalId("album", id, c.source, c.sourceId, c.url, true);
        return { entityType: "album", entityId: id, title: f.title };
      }
      case "track": {
        const id = await this.upsertTrack(f);
        await this.recordExternalId("track", id, c.source, c.sourceId, c.url, true);
        return { entityType: "track", entityId: id, title: f.title };
      }
      case "book": {
        const id = await this.getOrCreateBook(f);
        await this.recordExternalId("book", id, c.source, c.sourceId, c.url, true);
        return { entityType: "book", entityId: id, title: f.title };
      }
      case "media": {
        const id = await this.getOrCreateMedia(f, c);
        await this.recordExternalId(f.kind, id, `${c.source}:${f.kind}`, c.sourceId, c.url, true);
        return { entityType: f.kind, entityId: id, title: f.title, enrichType: "media" };
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

  private async getOrCreateMedia(f: FetchedMedia, c: { source: string; sourceId: string; url: string }): Promise<number> {
    const norm = normalize(f.title);
    let row = await this.first<{ id: number }>("SELECT id FROM media_items WHERE source = ? AND kind = ? AND source_id = ?", [c.source, f.kind, c.sourceId]);
    if (!row) row = await this.first<{ id: number }>("SELECT id FROM media_items WHERE kind = ? AND normalized_title = ?", [f.kind, norm]);

    if (row) {
      await this.run(
        `UPDATE media_items
         SET source = COALESCE(source, ?), source_id = COALESCE(source_id, ?), source_url = COALESCE(source_url, ?),
             year = COALESCE(year, ?), cover_url = COALESCE(cover_url, ?), description = COALESCE(description, ?)
         WHERE id = ?`,
        [c.source, c.sourceId, c.url, f.year ?? null, f.coverUrl ?? null, f.description ?? null, row.id],
      );
      return row.id;
    }

    return Number(
      await this.scalar(
        `INSERT INTO media_items (kind, title, normalized_title, source, source_id, source_url, year, cover_url, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id AS value`,
        [f.kind, f.title, norm, c.source, c.sourceId, c.url, f.year ?? null, f.coverUrl ?? null, f.description ?? null],
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
