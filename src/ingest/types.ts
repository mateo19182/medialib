export type Source = "spotify" | "youtube" | "bandcamp" | "goodreads" | "myanimelist";
export type MediaKind = "movie" | "series" | "anime" | "manga";
export type SourceKind = "track" | "album" | "artist" | "playlist" | "video" | "book" | "anime" | "manga";
export type EntityType = "artist" | "album" | "track" | "book" | MediaKind;
export const ARTIST_TYPES = ["musician", "visual_artist", "filmmaker", "writer", "performer", "other"] as const;
export type ArtistType = (typeof ARTIST_TYPES)[number];

export interface Classified {
  source: Source;
  kind: SourceKind;
  sourceId: string;
  url: string;
}

export interface FetchedArtist {
  entityType: "artist";
  name: string;
  artistType?: ArtistType;
  imageUrl?: string;
}
export interface FetchedAlbum {
  entityType: "album";
  title: string;
  artist: string;
  year?: number;
  coverUrl?: string;
}
export interface FetchedTrack {
  entityType: "track";
  title: string;
  artist: string;
  album?: string;
  year?: number;
  durationMs?: number;
  isrc?: string;
  coverUrl?: string;
}
export interface FetchedBook {
  entityType: "book";
  title: string;
  author: string;
  isbn?: string;
  year?: number;
  pageCount?: number;
  description?: string;
  coverUrl?: string;
}
export interface FetchedMedia {
  entityType: "media";
  kind: MediaKind;
  title: string;
  year?: number;
  description?: string;
  coverUrl?: string;
}

export type Fetched = FetchedArtist | FetchedAlbum | FetchedTrack | FetchedBook | FetchedMedia;
