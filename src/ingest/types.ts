export type Source = "spotify" | "youtube" | "bandcamp" | "goodreads";
export type SourceKind = "track" | "album" | "artist" | "playlist" | "video" | "book";
export type EntityType = "artist" | "album" | "track" | "book";

export interface Classified {
  source: Source;
  kind: SourceKind;
  sourceId: string;
  url: string;
}

export interface FetchedArtist {
  entityType: "artist";
  name: string;
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
  coverUrl?: string;
}

export type Fetched = FetchedArtist | FetchedAlbum | FetchedTrack | FetchedBook;
