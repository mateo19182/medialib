from __future__ import annotations

import logging
import threading
from datetime import datetime
from typing import Callable

from sqlalchemy import select

from medialib import adapters
from medialib.core.catalog import upsert_track
from medialib.core.db import (
    Album,
    Artist,
    ImportJob,
    Playlist,
    PlaylistTrack,
    SessionLocal,
    Source,
    SourceTrack,
    Track,
    TrackArtist,
)
from medialib.core.match import TrackKey

logger = logging.getLogger(__name__)


def _set_job(db, job_id: int, **fields) -> ImportJob:
    job = db.get(ImportJob, job_id)
    if job is None:
        raise RuntimeError(f"ImportJob {job_id} not found")
    for k, v in fields.items():
        setattr(job, k, v)
    db.commit()
    return job


def _run_in_thread(job_id: int, fn: Callable) -> None:
    def wrapper() -> None:
        db = SessionLocal()
        try:
            fn(db, job_id)
        except Exception as e:
            logger.exception("job %s failed", job_id)
            _set_job(db, job_id, status="error", message=str(e), finished_at=datetime.utcnow())
        finally:
            db.close()

    t = threading.Thread(target=wrapper, daemon=True, name=f"job-{job_id}")
    t.start()


# ----------------------------------------------------------------------------
# Spotify: saved tracks
# ----------------------------------------------------------------------------
def start_spotify_saved() -> int:
    db = SessionLocal()
    job = ImportJob(source=Source.spotify, status="running", message="Importing Spotify saved tracks")
    db.add(job)
    db.commit()
    db.refresh(job)
    job_id = job.id
    db.close()
    _run_in_thread(job_id, _spotify_saved_work)
    return job_id


def _spotify_saved_work(db, job_id: int) -> None:
    sp = adapters.spotify.client()
    total = adapters.spotify.saved_tracks_total(sp)
    _set_job(db, job_id, items_total=total)
    done = 0
    for item in adapters.spotify.iter_saved_tracks(sp):
        upsert_track(
            db,
            title=item["title"],
            artist=item["artist"],
            album=item.get("album"),
            duration_ms=item.get("duration_ms"),
            isrc=item.get("isrc"),
            source=Source.spotify,
            source_id=item["source_id"],
            raw_meta=item,
        )
        done += 1
        if done % 25 == 0:
            _set_job(db, job_id, items_done=done)
    db.commit()
    _set_job(db, job_id, items_done=done, status="done", message=f"Imported {done} tracks", finished_at=datetime.utcnow())


# ----------------------------------------------------------------------------
# Spotify: playlists
# ----------------------------------------------------------------------------
def start_spotify_playlists() -> int:
    db = SessionLocal()
    job = ImportJob(source=Source.spotify, status="running", message="Importing Spotify playlists")
    db.add(job)
    db.commit()
    db.refresh(job)
    job_id = job.id
    db.close()
    _run_in_thread(job_id, _spotify_playlists_work)
    return job_id


def _spotify_playlists_work(db, job_id: int) -> None:
    sp = adapters.spotify.client()
    total = adapters.spotify.playlists_total(sp)
    _set_job(db, job_id, items_total=total)
    done = 0
    for pl in adapters.spotify.iter_playlists(sp):
        db_pl = Playlist(
            name=pl["name"],
            source=Source.spotify,
            source_playlist_id=pl["source_playlist_id"],
        )
        db.add(db_pl)
        db.flush()
        pos = 0
        for t in adapters.spotify.iter_playlist_tracks(sp, pl["source_playlist_id"]):
            track = upsert_track(
                db,
                title=t["title"],
                artist=t["artist"],
                album=t.get("album"),
                duration_ms=t.get("duration_ms"),
                isrc=t.get("isrc"),
                source=Source.spotify,
                source_id=t["source_id"],
                raw_meta=t,
            )
            db.add(PlaylistTrack(playlist_id=db_pl.id, track_id=track.id, position=pos))
            pos += 1
        done += 1
        _set_job(db, job_id, items_done=done, message=f"Imported playlist: {pl['name']} ({pos} tracks)")
        db.commit()
    _set_job(db, job_id, status="done", message=f"Imported {done} playlists", finished_at=datetime.utcnow())


# ----------------------------------------------------------------------------
# Bandcamp: collection
# ----------------------------------------------------------------------------
def start_bandcamp() -> int:
    db = SessionLocal()
    job = ImportJob(source=Source.bandcamp, status="running", message="Importing Bandcamp collection")
    db.add(job)
    db.commit()
    db.refresh(job)
    job_id = job.id
    db.close()
    _run_in_thread(job_id, _bandcamp_work)
    return job_id


def _bandcamp_work(db, job_id: int) -> None:
    done = 0
    for item in adapters.bandcamp.fetch_collection():
        upsert_track(
            db,
            title=item["title"],
            artist=item["artist"],
            album=item.get("album"),
            duration_ms=item.get("duration_ms"),
            isrc=item.get("isrc"),
            source=Source.bandcamp,
            source_id=item["source_id"],
            raw_meta=item.get("raw"),
        )
        done += 1
        if done % 25 == 0:
            _set_job(db, job_id, items_done=done, message=f"Imported {done} items…")
    db.commit()
    _set_job(db, job_id, items_done=done, items_total=done, status="done", message=f"Imported {done} items", finished_at=datetime.utcnow())


# ----------------------------------------------------------------------------
# Migrate to YouTube Music
# ----------------------------------------------------------------------------
def start_migrate(playlist_id: int | None, target_name: str) -> int:
    db = SessionLocal()
    job = ImportJob(source=Source.ytmusic, status="running", message=f"Migrating to '{target_name}'")
    db.add(job)
    db.commit()
    db.refresh(job)
    job_id = job.id
    db.close()
    _run_in_thread(job_id, lambda db, jid: _migrate_work(db, jid, playlist_id, target_name))
    return job_id


def _migrate_work(db, job_id: int, playlist_id: int | None, target_name: str) -> None:
    if playlist_id:
        track_ids = [
            r[0]
            for r in db.execute(
                select(PlaylistTrack.track_id).where(PlaylistTrack.playlist_id == playlist_id)
            )
        ]
    else:
        track_ids = db.scalars(select(Track.id)).all()

    total = len(track_ids)
    _set_job(db, job_id, items_total=total, message=f"Searching YouTube Music for {total} tracks…")

    video_ids: list[str] = []
    skipped = 0
    done = 0
    for tid in track_ids:
        t = db.get(Track, tid)
        if not t:
            skipped += 1
            done += 1
            continue
        key = TrackKey(title=t.title, artist=t.artist.name, duration_ms=t.duration_ms, isrc=t.isrc)
        try:
            cands = adapters.youtube.search_track(key, limit=5)
            best = adapters.youtube.best_match(cands, key)
        except Exception as e:
            logger.warning("search failed for %s: %s", t.title, e)
            skipped += 1
            done += 1
            if done % 10 == 0:
                _set_job(db, job_id, items_done=done, message=f"Searching… {done}/{total} (skipped {skipped})")
            continue
        if best and best.get("video_id"):
            video_ids.append(best["video_id"])
        else:
            skipped += 1
        done += 1
        if done % 10 == 0:
            _set_job(db, job_id, items_done=done, message=f"Searching… {done}/{total} (skipped {skipped})")

    _set_job(db, job_id, items_done=done, message=f"Creating playlist '{target_name}' with {len(video_ids)} tracks…")

    pl_id = adapters.youtube.create_playlist(target_name)
    added = 0
    for i in range(0, len(video_ids), 25):
        chunk = video_ids[i : i + 25]
        adapters.youtube.add_tracks(pl_id, chunk)
        added += len(chunk)
        _set_job(db, job_id, message=f"Adding tracks… {added}/{len(video_ids)}")

    _set_job(
        db,
        job_id,
        status="done",
        message=f"Migrated {len(video_ids)} tracks to '{target_name}' (skipped {skipped}). Playlist: {pl_id}",
        finished_at=datetime.utcnow(),
    )


# ----------------------------------------------------------------------------
# Enrichment: MusicBrainz + Cover Art Archive
# ----------------------------------------------------------------------------
def start_enrich() -> int:
    db = SessionLocal()
    job = ImportJob(source=Source.musicbrainz, status="running", message="Enriching from MusicBrainz")
    db.add(job)
    db.commit()
    db.refresh(job)
    job_id = job.id
    db.close()
    _run_in_thread(job_id, _enrich_work)
    return job_id


def _enrich_work(db, job_id: int) -> None:
    from medialib.adapters import musicbrainz as mb

    # Find tracks with ISRCs that haven't been enriched yet
    tracks = db.scalars(
        select(Track)
        .where(Track.isrc.isnot(None))
        .where(Track.mbid.is_(None))
        .order_by(Track.id)
    ).all()

    total = len(tracks)
    _set_job(db, job_id, items_total=total, message=f"Enriching {total} tracks via MusicBrainz (1 req/sec)…")

    done = 0
    found = 0
    covers = 0
    for track in tracks:
        try:
            result = mb.lookup_isrc(track.isrc)
            # fallback to text search if ISRC not in MB
            if not result:
                primary_ta = db.scalars(
                    select(TrackArtist)
                    .where(TrackArtist.track_id == track.id, TrackArtist.role == "main")
                    .order_by(TrackArtist.position)
                    .limit(1)
                ).first()
                artist_name = primary_ta.artist.name if primary_ta else "Unknown"
                result = mb.search_recording(track.title, artist_name)
        except Exception as e:
            logger.warning("MB lookup failed for ISRC %s: %s", track.isrc, e)
            result = None

        if result:
            found += 1
            track.mbid = result.get("recording_mbid") or track.mbid

            # Update track artists with MBIDs
            mb_artists = result.get("artists", [])
            for mb_a in mb_artists[:1]:  # primary artist
                artist_row = db.execute(
                    select(Artist).where(Artist.normalized_name == _norm(mb_a["name"]))
                ).scalar_one_or_none()
                if artist_row and mb_a.get("mbid") and not artist_row.mbid:
                    artist_row.mbid = mb_a["mbid"]
                    if mb_a.get("genres"):
                        artist_row.genres = ",".join(result.get("genres", []))

            # Update/create album with MBID + cover art
            rgs = result.get("release_groups", [])
            if rgs:
                rg = rgs[0]
                album = db.execute(
                    select(Album).where(Album.id == track.album_id)
                ).scalar_one_or_none() if track.album_id else None
                if album and not album.mbid:
                    album.mbid = rg["mbid"]
                    album.year = rg.get("year")
                    if not album.cover_url:
                        cover = mb.get_cover_art(rg["mbid"], size=500)
                        if cover:
                            album.cover_url = cover
                            covers += 1

            # Store genres on track's primary artist
            if result.get("genres"):
                primary_ta = db.scalars(
                    select(TrackArtist)
                    .where(TrackArtist.track_id == track.id, TrackArtist.role == "main")
                    .order_by(TrackArtist.position)
                    .limit(1)
                ).first()
                if primary_ta and not primary_ta.artist.genres:
                    primary_ta.artist.genres = ",".join(result["genres"])
                    db.flush()

        done += 1
        if done % 25 == 0:
            _set_job(db, job_id, items_done=done, message=f"Enriching… {done}/{total} (found {found}, covers {covers})")
            db.commit()

    db.commit()
    _set_job(
        db,
        job_id,
        items_done=done,
        status="done",
        message=f"Enriched {found}/{total} tracks from MusicBrainz ({covers} cover arts found)",
        finished_at=datetime.utcnow(),
    )


def _norm(name: str) -> str:
    from medialib.core.match import normalize_artist
    return normalize_artist(name)


# ----------------------------------------------------------------------------
# Book enrichment: Open Library
# ----------------------------------------------------------------------------
def start_book_enrich() -> int:
    db = SessionLocal()
    job = ImportJob(source=Source.bandcamp, status="running", message="Enriching books from Open Library")
    db.add(job)
    db.commit()
    db.refresh(job)
    job_id = job.id
    db.close()
    _run_in_thread(job_id, _book_enrich_work)
    return job_id


def _book_enrich_work(db, job_id: int) -> None:
    from medialib.adapters import openlibrary as ol

    # Find books without OLID or cover
    books = db.scalars(
        select(Book).where(
            (Book.olid.is_(None)) | ((Book.cover_url.is_(None)) & (Book.isbn.isnot(None)))
        )
    ).all()

    total = len(books)
    _set_job(db, job_id, items_total=total, message=f"Enriching {total} books from Open Library…")

    done = 0
    found = 0
    covers = 0
    for book in books:
        if book.isbn:
            result = ol.search_by_isbn(book.isbn)
        else:
            results = ol.search_by_title(book.title, limit=1)
            result = results[0] if results else None

        if result:
            found += 1
            if not book.olid:
                book.olid = result.get("olid")
            if not book.cover_url:
                book.cover_url = result.get("cover_url") or ol.cover_url(isbn=book.isbn)
                if book.cover_url:
                    covers += 1
            if not book.publisher:
                book.publisher = result.get("publisher")
            if not book.year:
                book.year = result.get("year")
            if not book.page_count:
                book.page_count = result.get("page_count")
            if not book.description:
                book.description = result.get("description")
            book.enriched_at = datetime.utcnow()

        done += 1
        if done % 10 == 0:
            _set_job(db, job_id, items_done=done, message=f"Enriching books… {done}/{total} (found {found}, covers {covers})")
            db.commit()

    db.commit()
    _set_job(
        db,
        job_id,
        items_done=done,
        status="done",
        message=f"Enriched {found}/{total} books ({covers} covers found)",
        finished_at=datetime.utcnow(),
    )
