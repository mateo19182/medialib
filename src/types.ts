import { LibraryDb } from "./db/library";

/** Worker bindings and secrets. */
export interface Env extends Cloudflare.Env {
  // Secrets (optional at type level; required at runtime for the features that use them)
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_USER_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  YOUTUBE_API_KEY?: string;
  TMDB_API_TOKEN?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
}

export function getLibrary(env: Env) {
  return new LibraryDb(env);
}

export interface LibraryStats {
  tracks: number;
  artists: number;
  albums: number;
  books: number;
  movies: number;
  series: number;
  anime: number;
  manga: number;
  links: number;
  pending: number;
}
