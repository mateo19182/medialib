from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from medialib.core.artists import split_artists
from medialib.core.db import Album, Artist, Source, SourceTrack, Track, TrackArtist
from medialib.core.match import TrackKey, is_match, normalize_artist, normalize_title


def _get_or_create_artist(db: Session, name: str) -> Artist:
    norm = normalize_artist(name)
    row = db.execute(select(Artist).where(Artist.normalized_name == norm)).scalar_one_or_none()
    if row is not None:
        return row
    artist = Artist(name=name, normalized_name=norm)
    db.add(artist)
    db.flush()
    return artist


def _get_or_create_album(db: Session, title: str, primary_artist: Artist) -> Album:
    norm = normalize_title(title)
    row = db.execute(
        select(Album).where(
            Album.normalized_title == norm,
            Album.artist_id == primary_artist.id,
        )
    ).scalar_one_or_none()
    if row is not None:
        return row
    album = Album(title=title, normalized_title=norm, artist_id=primary_artist.id)
    db.add(album)
    db.flush()
    return album


def _ensure_track_artists(db: Session, track: Track, raw_artist: str) -> Artist:
    """Split compound artist name, create individual artists + TrackArtist entries.
    Returns the primary (first) artist."""
    parsed = split_artists(raw_artist)
    primary = None
    seen: set[int] = set()
    for pos, pa in enumerate(parsed):
        artist_row = _get_or_create_artist(db, pa.name)
        if pos == 0:
            primary = artist_row
        if artist_row.id in seen:
            continue
        seen.add(artist_row.id)
        existing = db.execute(
            select(TrackArtist).where(
                TrackArtist.track_id == track.id,
                TrackArtist.artist_id == artist_row.id,
            )
        ).scalar_one_or_none()
        if existing is None:
            db.add(
                TrackArtist(
                    track_id=track.id,
                    artist_id=artist_row.id,
                    position=pos,
                    role=pa.role,
                )
            )
    return primary or _get_or_create_artist(db, raw_artist)


def _find_existing_track(db: Session, key: TrackKey) -> Track | None:
    if key.isrc:
        t = db.execute(select(Track).where(Track.isrc == key.isrc.upper())).scalar_one_or_none()
        if t is not None:
            return t
    # exact normalized (title, artist) path using compound artist for matching
    artist = _get_or_create_artist(db, key.artist)
    t = db.execute(
        select(Track).where(
            Track.normalized_title == key.norm_title,
            Track.artist_id == artist.id,
        )
    ).scalar_one_or_none()
    if t is not None:
        return t
    # fuzzy scan over same-artist tracks
    candidates = db.scalars(
        select(Track).where(Track.artist_id == artist.id)
    ).all()
    for c in candidates:
        ck = TrackKey(
            title=c.title,
            artist=artist.name,
            duration_ms=c.duration_ms,
            isrc=c.isrc,
        )
        if is_match(key, ck):
            return c
    return None


def upsert_track(
    db: Session,
    *,
    title: str,
    artist: str,
    album: str | None = None,
    duration_ms: int | None = None,
    isrc: str | None = None,
    source: Source,
    source_id: str,
    raw_meta: dict | None = None,
) -> Track:
    key = TrackKey(title=title, artist=artist, duration_ms=duration_ms, isrc=isrc)
    track = _find_existing_track(db, key)
    if track is None:
        # Create track with the compound artist as artist_id (legacy, for dedup)
        artist_row = _get_or_create_artist(db, artist)
        track = Track(
            title=title,
            normalized_title=key.norm_title,
            artist_id=artist_row.id,
            album=album,
            duration_ms=duration_ms,
            isrc=(isrc.upper() if isrc else None),
        )
        db.add(track)
        db.flush()
    else:
        if not track.isrc and isrc:
            track.isrc = isrc.upper()
        if not track.album and album:
            track.album = album
        if not track.duration_ms and duration_ms:
            track.duration_ms = duration_ms

    # Ensure individual artists are split and linked via TrackArtist
    primary = _ensure_track_artists(db, track, artist)

    # Create/find album and link
    if album and primary:
        album_row = _get_or_create_album(db, album, primary)
        if not track.album_id:
            track.album_id = album_row.id

    # Source track link
    src = db.execute(
        select(SourceTrack).where(
            SourceTrack.source == source,
            SourceTrack.source_id == source_id,
        )
    ).scalar_one_or_none()
    if src is None:
        db.add(
            SourceTrack(
                source=source,
                source_id=source_id,
                track_id=track.id,
                raw_meta=raw_meta,
            )
        )
    else:
        src.raw_meta = raw_meta or src.raw_meta

    return track
