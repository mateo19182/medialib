import { DurableObject } from "cloudflare:workers";
import type { Env, LibraryStats } from "../types";
import { SCHEMA } from "../db/schema";

/**
 * The one Durable Object that owns the entire library: SQLite catalog + the
 * background job loop (alarms, added in later milestones). Single-user, so a
 * single instance addressed by a fixed name (see getLibrary()).
 */
export class Library extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Schema setup is the one legitimate use of blockConcurrencyWhile: it runs
    // once on cold start before any request is served, guaranteeing the tables
    // exist. No external I/O happens inside.
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA) this.sql.exec(stmt);
    });
  }

  /** Cheap liveness check. */
  ping(): string {
    return "pong";
  }

  /** Top-level counts for the dashboard. */
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

  /** Most recently saved links (for the dashboard / bot /recent). */
  recent(limit = 20): Record<string, unknown>[] {
    return this.sql
      .exec(
        "SELECT id, url, source, source_kind, status, saved_at, saved_via FROM links ORDER BY saved_at DESC, id DESC LIMIT ?",
        limit,
      )
      .toArray() as Record<string, unknown>[];
  }
}
