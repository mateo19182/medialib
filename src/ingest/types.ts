export const ITEM_KINDS = ["author", "artist", "album", "track", "book", "movie", "series", "anime", "manga", "webtoon", "comic"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const VISUAL_KINDS = ["movie", "series", "anime", "manga", "webtoon", "comic"] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];

export const PROVIDERS = [
  "spotify", "youtube", "bandcamp", "goodreads", "myanimelist", "webtoon", "manual",
  "deezer", "openlibrary", "tmdb", "musicbrainz", "musicbrainz-release",
  "musicbrainz-recording", "isrc", "isbn", "deezer-artist", "deezer-album",
] as const;
export type Provider = (typeof PROVIDERS)[number];
export const ARTIST_TYPES = ["musician", "visual_artist", "filmmaker", "writer", "performer", "other"] as const;
export type ArtistType = (typeof ARTIST_TYPES)[number];

export interface Classified {
  provider: Provider;
  itemKind: ItemKind | null;
  providerId: string;
  url: string;
}

export interface FetchedArtist {
  kind: "artist";
  name: string;
  artistType?: ArtistType;
  imageUrl?: string;
}
export interface FetchedAlbum {
  kind: "album";
  title: string;
  artist: string;
  year?: number;
  coverUrl?: string;
}
export interface FetchedTrack {
  kind: "track";
  title: string;
  artist: string;
  album?: string;
  year?: number;
  durationMs?: number;
  isrc?: string;
  coverUrl?: string;
}
export interface FetchedBook {
  kind: "book";
  title: string;
  author: string;
  isbn?: string;
  year?: number;
  pageCount?: number;
  description?: string;
  coverUrl?: string;
}
export interface FetchedVisual {
  kind: VisualKind;
  title: string;
  year?: number;
  description?: string;
  coverUrl?: string;
}

export type Fetched = FetchedArtist | FetchedAlbum | FetchedTrack | FetchedBook | FetchedVisual;
