from __future__ import annotations

import logging
import shutil
from datetime import datetime

from sqlalchemy import inspect, select, text

from medialib.core.artists import split_artists
from medialib.core.match import normalize_artist, normalize_title
from medialib.config import ROOT

logger = logging.getLogger(__name__)


def _table_exists(inspector, name: str) -> bool:
    return name in inspector.get_table_names()


def _column_exists(inspector, table: str, column: str) -> bool:
    if not _table_exists(inspector, table):
        return False
    return column in {c["name"] for c in inspector.get_columns(table)}


def _backup_db() -> None:
    db_path = ROOT / "data" / "medialib.db"
    if db_path.exists():
        bak = db_path.with_suffix(".db.bak")
        shutil.copy2(db_path, bak)
        logger.info("backed up db to %s", bak)


def run_migration() -> None:
    from medialib.core.db import engine

    insp = inspect(engine)

    # Always ensure new columns exist on existing tables
    alter_statements: list[str] = []

    if _table_exists(insp, "artists"):
        if not _column_exists(insp, "artists", "image_url"):
            alter_statements.append("ALTER TABLE artists ADD COLUMN image_url VARCHAR(1000)")
        if not _column_exists(insp, "artists", "genres"):
            alter_statements.append("ALTER TABLE artists ADD COLUMN genres VARCHAR(1000)")
        if not _column_exists(insp, "artists", "enriched_at"):
            alter_statements.append("ALTER TABLE artists ADD COLUMN enriched_at DATETIME")

    if _table_exists(insp, "tracks"):
        if not _column_exists(insp, "tracks", "album_id"):
            alter_statements.append("ALTER TABLE tracks ADD COLUMN album_id INTEGER")
        if not _column_exists(insp, "tracks", "mbid"):
            alter_statements.append("ALTER TABLE tracks ADD COLUMN mbid VARCHAR(64)")

    if alter_statements:
        with engine.begin() as conn:
            for stmt in alter_statements:
                conn.execute(text(stmt))
        logger.info("applied %d ALTER TABLE statements", len(alter_statements))


def migrate_data_if_needed() -> None:
    from medialib.core.db import engine

    insp = inspect(engine)
    if not _table_exists(insp, "track_artists"):
        return

    # Check if migration already done: any TrackArtist rows?
    with engine.begin() as conn:
        count = conn.execute(text("SELECT COUNT(*) FROM track_artists")).scalar()
    if count and count > 0:
        logger.info("track_artists already populated (%d rows), skipping migration", count)
        return

    _backup_db()
    _migrate_data()


def _migrate_data() -> None:
    from medialib.core.db import (
        Album,
        Artist,
        SessionLocal,
        Track,
        TrackArtist,
    )

    logger.info("starting artist disaggregation migration")
    db = SessionLocal()
    try:
        tracks = db.scalars(select(Track)).all()
        logger.info("migrating %d tracks", len(tracks))

        artist_cache: dict[str, Artist] = {}
        album_cache: dict[str, Album] = {}

        def _get_or_create_artist(name: str) -> Artist:
            norm = normalize_artist(name)
            if norm in artist_cache:
                return artist_cache[norm]
            row = db.execute(
                select(Artist).where(Artist.normalized_name == norm)
            ).scalar_one_or_none()
            if row is None:
                row = Artist(name=name, normalized_name=norm)
                db.add(row)
                db.flush()
            artist_cache[norm] = row
            return row

        def _get_or_create_album(title: str, primary_artist: Artist) -> Album:
            norm = normalize_title(title)
            key = f"{norm}:{primary_artist.id}"
            if key in album_cache:
                return album_cache[key]
            row = db.execute(
                select(Album).where(
                    Album.normalized_title == norm,
                    Album.artist_id == primary_artist.id,
                )
            ).scalar_one_or_none()
            if row is None:
                row = Album(title=title, normalized_title=norm, artist_id=primary_artist.id)
                db.add(row)
                db.flush()
            album_cache[key] = row
            return row

        done = 0
        for track in tracks:
            # The track's current artist_id points to a compound-name Artist
            compound_artist = db.get(Artist, track.artist_id) if track.artist_id else None
            raw_name = compound_artist.name if compound_artist else "Unknown"

            parsed = split_artists(raw_name)

            # Create individual artist rows and TrackArtist entries
            primary = None
            seen_artists: set[int] = set()
            for pos, pa in enumerate(parsed):
                artist_row = _get_or_create_artist(pa.name)
                if pos == 0:
                    primary = artist_row

                # skip if we already linked this artist to this track (dedup within same track)
                if artist_row.id in seen_artists:
                    continue
                seen_artists.add(artist_row.id)

                db.add(
                    TrackArtist(
                        track_id=track.id,
                        artist_id=artist_row.id,
                        position=pos,
                        role=pa.role,
                    )
                )

            # Create Album and link (don't touch track.artist_id — TrackArtist is source of truth)
            if track.album and primary:
                album_row = _get_or_create_album(track.album, primary)
                track.album_id = album_row.id

            done += 1
            if done % 500 == 0:
                db.commit()
                logger.info("migration progress: %d/%d", done, len(tracks))

        db.commit()
        logger.info("migration complete: %d tracks processed", done)
    finally:
        db.close()
