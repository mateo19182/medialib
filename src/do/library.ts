import { DurableObject } from "cloudflare:workers";
import type { Env, LibraryStats } from "../types";
import { SCHEMA } from "../db/schema";
import { classify, fetchMetadata } from "../ingest";
import type { Fetched } from "../ingest";
import type { FetchedBook } from "../ingest/types";
import { normalize, splitArtists } from "../util";

export interface SaveResult {
  ok: boolean;
  duplicate?: boolean;
  linkId?: number;
  status?: string;
  entityType?: string | null;
  title?: string;
  error?: string;
}

export interface ArtistSummary {
  id: number;
  name: string;
  image_url: string | null;
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
}

export interface TrackRow {
  id: number;
  title: string;
  duration_ms: number | null;
  album: string | null;
}

export interface ArtistDetail {
  artist: { id: number; name: string; image_url: string | null; genres: string | null };
  albums: AlbumRow[];
  tracks: TrackRow[];
}

export interface BookRow {
  id: number;
  title: string;
  author: string | null;
  cover_url: string | null;
  year: number | null;
  reading_status: string | null;
}

/**
 * The one Durable Object that owns the entire library: SQLite catalog + the
 * ingestion pipeline. Single-user, so a single instance addressed by a fixed
 * name (see getLibrary()).
 */
export class Library extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA) this.sql.exec(stmt);
      this.ensureColumns();
    });
  }

  /**
   * Additive migrations: add columns introduced after a table was first
   * created, so evolving SCHEMA doesn't require wiping existing DOs.
   */
  private ensureColumns(): void {
    const wanted: Record<string, Record<string, string>> = {
      links: { title: "TEXT" },
    };
    for (const [table, cols] of Object.entries(wanted)) {
      const have = new Set(
        (this.sql.exec(`PRAGMA table_info(${table})`).toArray() as { name: string }[]).map((r) => r.name),
      );
      for (const [col, type] of Object.entries(cols)) {
        if (!have.has(col)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
      }
    }
  }

  ping(): string {
    return "pong";
  }

  stats(): LibraryStats {
    const count = (table: string): number =>
      Number(this.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n);
    return {
      tracks: count("tracks"),
      artists: count("artists"),
      albums: count("albums"),
      books: count("books"),
      links: count("links"),
    };
  }

  recent(limit = 20): RecentLink[] {
    return this.sql
      .exec(
        "SELECT id, url, source, source_kind, entity_type, title, status, saved_at, saved_via FROM links ORDER BY saved_at DESC, id DESC LIMIT ?",
        limit,
      )
      .toArray() as unknown as RecentLink[];
  }

  /** Artists that have at least one album or track, with counts, for /library. */
  listArtists(): ArtistSummary[] {
    return this.sql
      .exec(
        `SELECT a.id, a.name, a.image_url,
                (SELECT COUNT(*) FROM albums al WHERE al.artist_id = a.id) AS albums,
                (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id) AS tracks
         FROM artists a
         WHERE albums > 0 OR tracks > 0
         ORDER BY a.name COLLATE NOCASE`,
      )
      .toArray() as unknown as ArtistSummary[];
  }

  /** Artist page: the artist plus their albums and tracks. */
  artistDetail(id: number): ArtistDetail | null {
    const artist = this.sql.exec("SELECT id, name, image_url, genres FROM artists WHERE id = ?", id).toArray()[0] as
      | ArtistDetail["artist"]
      | undefined;
    if (!artist) return null;
    const albums = this.sql
      .exec("SELECT id, title, year, cover_url FROM albums WHERE artist_id = ? ORDER BY year, title COLLATE NOCASE", id)
      .toArray() as unknown as AlbumRow[];
    const tracks = this.sql
      .exec(
        `SELECT t.id, t.title, t.duration_ms, al.title AS album
         FROM tracks t LEFT JOIN albums al ON al.id = t.album_id
         WHERE t.artist_id = ? ORDER BY t.title COLLATE NOCASE`,
        id,
      )
      .toArray() as unknown as TrackRow[];
    return { artist, albums, tracks };
  }

  /** All books with their primary author, for /books. */
  listBooks(): BookRow[] {
    return this.sql
      .exec(
        `SELECT b.id, b.title, b.cover_url, b.year, b.reading_status,
                (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                 WHERE ba.book_id = b.id ORDER BY ba.position LIMIT 1) AS author
         FROM books b ORDER BY b.title COLLATE NOCASE`,
      )
      .toArray() as unknown as BookRow[];
  }

  /** Fuzzy search across artists, albums, tracks, and books. */
  search(query: string, limit = 10): { type: string; id: number; name: string; sub: string }[] {
    const like = `%${normalize(query)}%`;
    if (like === "%%") return [];
    const out: { type: string; id: number; name: string; sub: string }[] = [];
    const add = (rows: unknown[], type: string, sub: (r: Record<string, unknown>) => string) => {
      for (const r of rows as Record<string, unknown>[]) out.push({ type, id: Number(r.id), name: String(r.name), sub: sub(r) });
    };
    add(this.sql.exec("SELECT id, name FROM artists WHERE normalized_name LIKE ? LIMIT ?", like, limit).toArray(), "artist", () => "");
    add(
      this.sql
        .exec(
          "SELECT al.id, al.title AS name, a.name AS artist FROM albums al LEFT JOIN artists a ON a.id = al.artist_id WHERE al.normalized_title LIKE ? LIMIT ?",
          like,
          limit,
        )
        .toArray(),
      "album",
      (r) => String(r.artist ?? ""),
    );
    add(
      this.sql
        .exec(
          "SELECT t.id, t.title AS name, a.name AS artist FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.normalized_title LIKE ? LIMIT ?",
          like,
          limit,
        )
        .toArray(),
      "track",
      (r) => String(r.artist ?? ""),
    );
    add(this.sql.exec("SELECT id, title AS name FROM books WHERE normalized_title LIKE ? LIMIT ?", like, limit).toArray(), "book", () => "");
    return out.slice(0, limit);
  }

  // --- ingestion -----------------------------------------------------------

  /** Save a link: classify -> dedupe -> fetch metadata -> upsert -> record. */
  async saveLink(url: string, via: "web" | "telegram" = "web"): Promise<SaveResult> {
    const c = classify(url);
    if (!c) return { ok: false, error: "Unrecognized link" };

    const existing = this.sql
      .exec("SELECT id, title, status, entity_type FROM links WHERE source = ? AND source_id = ?", c.source, c.sourceId)
      .toArray()[0] as { id: number; title: string | null; status: string; entity_type: string | null } | undefined;
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
      const up = this.upsertEntity(fetched);
      entityType = up.entityType;
      entityId = up.entityId;
      title = up.title;
    }
    const status = fetched ? "ok" : error ? "error" : "pending";

    let linkId: number;
    try {
      linkId = Number(
        this.sql
          .exec(
            `INSERT INTO links (url, source, source_kind, source_id, entity_type, entity_id, title, status, raw_json, saved_via)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            url,
            c.source,
            c.kind,
            c.sourceId,
            entityType,
            entityId,
            title,
            status,
            JSON.stringify(fetched ?? (error ? { error } : {})),
            via,
          )
          .one().id,
      );
    } catch {
      // Lost a race on the UNIQUE(source, source_id) constraint — treat as dup.
      const dup = this.sql
        .exec("SELECT id, title, status FROM links WHERE source = ? AND source_id = ?", c.source, c.sourceId)
        .toArray()[0] as { id: number; title: string | null; status: string } | undefined;
      return { ok: true, duplicate: true, linkId: dup?.id, status: dup?.status, title: dup?.title ?? url };
    }

    return { ok: true, linkId, status, entityType, title, error };
  }

  private upsertEntity(f: Fetched): { entityType: string; entityId: number; title: string } {
    switch (f.entityType) {
      case "artist": {
        const id = this.getOrCreateArtist(f.name, f.imageUrl);
        return { entityType: "artist", entityId: id, title: f.name };
      }
      case "album": {
        const artistId = this.getOrCreateArtist(f.artist);
        const id = this.getOrCreateAlbum(f.title, artistId, { year: f.year, coverUrl: f.coverUrl });
        return { entityType: "album", entityId: id, title: f.title };
      }
      case "track": {
        const id = this.upsertTrack(f);
        return { entityType: "track", entityId: id, title: f.title };
      }
      case "book": {
        const id = this.getOrCreateBook(f);
        return { entityType: "book", entityId: id, title: f.title };
      }
    }
  }

  private getOrCreateAuthor(name: string): number {
    const norm = normalize(name);
    const row = this.sql.exec("SELECT id FROM authors WHERE normalized_name = ?", norm).toArray()[0] as
      | { id: number }
      | undefined;
    if (row) return row.id;
    return Number(
      this.sql.exec("INSERT INTO authors (name, normalized_name) VALUES (?, ?) RETURNING id", name, norm).one().id,
    );
  }

  private getOrCreateBook(f: FetchedBook): number {
    const norm = normalize(f.title);
    let row: { id: number } | undefined;
    if (f.isbn) row = this.sql.exec("SELECT id FROM books WHERE isbn = ?", f.isbn).toArray()[0] as { id: number } | undefined;
    if (!row)
      row = this.sql.exec("SELECT id FROM books WHERE normalized_title = ? AND isbn IS NULL", norm).toArray()[0] as
        | { id: number }
        | undefined;

    let bookId: number;
    if (row) {
      bookId = row.id;
      this.sql.exec(
        `UPDATE books SET isbn = COALESCE(isbn, ?), year = COALESCE(year, ?), page_count = COALESCE(page_count, ?),
                          cover_url = COALESCE(cover_url, ?), description = COALESCE(description, ?) WHERE id = ?`,
        f.isbn ?? null,
        f.year ?? null,
        f.pageCount ?? null,
        f.coverUrl ?? null,
        f.description ?? null,
        bookId,
      );
    } else {
      bookId = Number(
        this.sql
          .exec(
            `INSERT INTO books (title, normalized_title, isbn, year, page_count, cover_url, description, reading_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'want') RETURNING id`,
            f.title,
            norm,
            f.isbn ?? null,
            f.year ?? null,
            f.pageCount ?? null,
            f.coverUrl ?? null,
            f.description ?? null,
          )
          .one().id,
      );
    }

    f.author.split(/,\s*/).forEach((name, i) => {
      if (!name.trim()) return;
      const authorId = this.getOrCreateAuthor(name.trim());
      this.sql.exec("INSERT OR IGNORE INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)", bookId, authorId, i);
    });
    return bookId;
  }

  private getOrCreateArtist(name: string, imageUrl?: string): number {
    const norm = normalize(name);
    const row = this.sql.exec("SELECT id FROM artists WHERE normalized_name = ?", norm).toArray()[0] as
      | { id: number }
      | undefined;
    if (row) {
      if (imageUrl) this.sql.exec("UPDATE artists SET image_url = COALESCE(image_url, ?) WHERE id = ?", imageUrl, row.id);
      return row.id;
    }
    return Number(
      this.sql
        .exec("INSERT INTO artists (name, normalized_name, image_url) VALUES (?, ?, ?) RETURNING id", name, norm, imageUrl ?? null)
        .one().id,
    );
  }

  private getOrCreateAlbum(title: string, artistId: number, extra: { year?: number; coverUrl?: string } = {}): number {
    const norm = normalize(title);
    const row = this.sql
      .exec("SELECT id FROM albums WHERE normalized_title = ? AND artist_id = ?", norm, artistId)
      .toArray()[0] as { id: number } | undefined;
    if (row) {
      this.sql.exec(
        "UPDATE albums SET year = COALESCE(year, ?), cover_url = COALESCE(cover_url, ?) WHERE id = ?",
        extra.year ?? null,
        extra.coverUrl ?? null,
        row.id,
      );
      return row.id;
    }
    return Number(
      this.sql
        .exec(
          "INSERT INTO albums (title, normalized_title, artist_id, year, cover_url) VALUES (?, ?, ?, ?, ?) RETURNING id",
          title,
          norm,
          artistId,
          extra.year ?? null,
          extra.coverUrl ?? null,
        )
        .one().id,
    );
  }

  private upsertTrack(f: { title: string; artist: string; album?: string; year?: number; durationMs?: number; coverUrl?: string }): number {
    const artists = splitArtists(f.artist);
    const primaryId = this.getOrCreateArtist(artists[0]?.name ?? f.artist);
    const norm = normalize(f.title);

    let albumId: number | null = null;
    if (f.album) albumId = this.getOrCreateAlbum(f.album, primaryId, { year: f.year, coverUrl: f.coverUrl });

    let row = this.sql
      .exec("SELECT id FROM tracks WHERE normalized_title = ? AND artist_id = ?", norm, primaryId)
      .toArray()[0] as { id: number } | undefined;
    let trackId: number;
    if (row) {
      trackId = row.id;
      this.sql.exec(
        "UPDATE tracks SET album_id = COALESCE(album_id, ?), duration_ms = COALESCE(duration_ms, ?) WHERE id = ?",
        albumId,
        f.durationMs ?? null,
        trackId,
      );
    } else {
      trackId = Number(
        this.sql
          .exec(
            "INSERT INTO tracks (title, normalized_title, artist_id, album_id, duration_ms) VALUES (?, ?, ?, ?, ?) RETURNING id",
            f.title,
            norm,
            primaryId,
            albumId,
            f.durationMs ?? null,
          )
          .one().id,
      );
    }

    // Link every contributing artist (main/featured) for disaggregated browsing.
    artists.forEach((a, i) => {
      const aid = this.getOrCreateArtist(a.name);
      this.sql.exec(
        "INSERT OR IGNORE INTO track_artists (track_id, artist_id, position, role) VALUES (?, ?, ?, ?)",
        trackId,
        aid,
        i,
        a.role,
      );
    });
    return trackId;
  }
}
