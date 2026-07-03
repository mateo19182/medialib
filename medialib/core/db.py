from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    ForeignKey,
    Integer,
    JSON,
    String,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

from medialib.config import settings


class Base(DeclarativeBase):
    pass


class Source(str, enum.Enum):
    spotify = "spotify"
    ytmusic = "ytmusic"
    bandcamp = "bandcamp"
    musicbrainz = "musicbrainz"


class Artist(Base):
    __tablename__ = "artists"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(500), nullable=False)
    normalized_name: Mapped[str] = mapped_column(String(500), index=True, nullable=False)
    mbid: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    genres: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    enriched_at: Mapped[datetime | None] = mapped_column(nullable=True)

    __table_args__ = (UniqueConstraint("normalized_name", name="uq_artist_normalized"),)


class Album(Base):
    __tablename__ = "albums"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(1000), nullable=False)
    normalized_title: Mapped[str] = mapped_column(String(1000), index=True, nullable=False)
    artist_id: Mapped[int | None] = mapped_column(ForeignKey("artists.id"), index=True, nullable=True)
    mbid: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    cover_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    enriched_at: Mapped[datetime | None] = mapped_column(nullable=True)

    artist: Mapped[Artist | None] = relationship(lazy="joined")
    tracks: Mapped[list["Track"]] = relationship(back_populates="album_rel", lazy="select")

    __table_args__ = (
        UniqueConstraint("normalized_title", "artist_id", name="uq_album_title_artist"),
    )


class Track(Base):
    __tablename__ = "tracks"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(1000), nullable=False)
    normalized_title: Mapped[str] = mapped_column(String(1000), index=True, nullable=False)
    artist_id: Mapped[int | None] = mapped_column(ForeignKey("artists.id"), index=True, nullable=True)
    album_id: Mapped[int | None] = mapped_column(ForeignKey("albums.id"), index=True, nullable=True)
    album: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    isrc: Mapped[str | None] = mapped_column(String(32), index=True, nullable=True)
    mbid: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)

    artist: Mapped[Artist | None] = relationship(lazy="joined", foreign_keys=[artist_id])
    album_rel: Mapped[Album | None] = relationship(back_populates="tracks", lazy="joined", foreign_keys=[album_id])
    source_tracks: Mapped[list["SourceTrack"]] = relationship(
        back_populates="track", cascade="all, delete-orphan"
    )
    track_artists: Mapped[list["TrackArtist"]] = relationship(
        back_populates="track", cascade="all, delete-orphan", order_by="TrackArtist.position"
    )

    __table_args__ = (UniqueConstraint("normalized_title", "artist_id", name="uq_track_title_artist"),)


class TrackArtist(Base):
    __tablename__ = "track_artists"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id"), index=True, nullable=False)
    artist_id: Mapped[int] = mapped_column(ForeignKey("artists.id"), index=True, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="main")

    track: Mapped[Track] = relationship(back_populates="track_artists")
    artist: Mapped[Artist] = relationship(lazy="joined")

    __table_args__ = (
        UniqueConstraint("track_id", "artist_id", name="uq_track_artist"),
    )


class SourceTrack(Base):
    __tablename__ = "source_tracks"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source: Mapped[Source] = mapped_column(index=True, nullable=False)
    source_id: Mapped[str] = mapped_column(String(256), nullable=False)
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id"), index=True)
    raw_meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    imported_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)

    track: Mapped[Track] = relationship(back_populates="source_tracks")

    __table_args__ = (UniqueConstraint("source", "source_id", name="uq_source_track"),)


class Playlist(Base):
    __tablename__ = "playlists"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(500), nullable=False)
    source: Mapped[Source] = mapped_column(nullable=False)
    source_playlist_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    imported_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)

    tracks: Mapped[list["PlaylistTrack"]] = relationship(
        back_populates="playlist", cascade="all, delete-orphan", order_by="PlaylistTrack.position"
    )


class PlaylistTrack(Base):
    __tablename__ = "playlist_tracks"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    playlist_id: Mapped[int] = mapped_column(ForeignKey("playlists.id"), index=True)
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id"), index=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False)

    playlist: Mapped[Playlist] = relationship(back_populates="tracks")


class ImportJob(Base):
    __tablename__ = "import_jobs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source: Mapped[Source] = mapped_column(nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    items_total: Mapped[int] = mapped_column(Integer, default=0)
    items_done: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    started_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(nullable=True)


# ----------------------------------------------------------------------------
# Books
# ----------------------------------------------------------------------------
class BookAuthor(Base):
    __tablename__ = "book_authors"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(500), nullable=False)
    normalized_name: Mapped[str] = mapped_column(String(500), index=True, nullable=False)
    olid: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    bio: Mapped[str | None] = mapped_column(String(5000), nullable=True)
    enriched_at: Mapped[datetime | None] = mapped_column(nullable=True)

    __table_args__ = (UniqueConstraint("normalized_name", name="uq_book_author_normalized"),)


class Book(Base):
    __tablename__ = "books"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(1000), nullable=False)
    normalized_title: Mapped[str] = mapped_column(String(1000), index=True, nullable=False)
    isbn: Mapped[str | None] = mapped_column(String(32), index=True, nullable=True)
    olid: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    publisher: Mapped[str | None] = mapped_column(String(500), nullable=True)
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cover_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    description: Mapped[str | None] = mapped_column(String(5000), nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reading_status: Mapped[str | None] = mapped_column(String(32), nullable=True, default=None)
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    review: Mapped[str | None] = mapped_column(String(5000), nullable=True)
    enriched_at: Mapped[datetime | None] = mapped_column(nullable=True)
    imported_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)

    authors: Mapped[list["BookAuthorLink"]] = relationship(
        back_populates="book", cascade="all, delete-orphan", order_by="BookAuthorLink.position"
    )

    __table_args__ = (UniqueConstraint("normalized_title", "isbn", name="uq_book_title_isbn"),)


class BookAuthorLink(Base):
    __tablename__ = "book_author_links"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"), index=True, nullable=False)
    author_id: Mapped[int] = mapped_column(ForeignKey("book_authors.id"), index=True, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    book: Mapped[Book] = relationship(back_populates="authors")
    author: Mapped[BookAuthor] = relationship(lazy="joined")

    __table_args__ = (UniqueConstraint("book_id", "author_id", name="uq_book_author_link"),)


engine = create_engine(settings.database_url, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    from medialib.core.migrate import run_migration

    run_migration()
    Base.metadata.create_all(bind=engine)
    from medialib.core.migrate import migrate_data_if_needed

    migrate_data_if_needed()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
