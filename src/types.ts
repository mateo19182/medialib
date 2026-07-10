import type { Library } from "./do/library";

/** Worker + Durable Object bindings and secrets. */
export interface Env {
  LIBRARY: DurableObjectNamespace<Library>;
  MEDIA: R2Bucket;

  // Secrets (optional at type level; required at runtime for the features that use them)
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_USER_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  YOUTUBE_API_KEY?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
}

/** There is exactly one library (single-user); route every request to it. */
export const LIBRARY_INSTANCE = "library";

export function getLibrary(env: Env) {
  return env.LIBRARY.get(env.LIBRARY.idFromName(LIBRARY_INSTANCE));
}

export interface LibraryStats {
  tracks: number;
  artists: number;
  albums: number;
  books: number;
  links: number;
}
