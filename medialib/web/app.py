from __future__ import annotations

from pathlib import Path

from fastapi import Depends, FastAPI, Form, Request, UploadFile, File
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload
from starlette.middleware.sessions import SessionMiddleware

from medialib import adapters
from medialib.config import settings
from medialib.core import jobs
from medialib.core.db import (
    Album,
    Artist,
    Book,
    BookAuthor,
    BookAuthorLink,
    ImportJob,
    Playlist,
    PlaylistTrack,
    Source,
    SourceTrack,
    Track,
    TrackArtist,
    get_db,
    init_db,
)

TEMPLATES = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

app = FastAPI(title="medialib")
app.add_middleware(SessionMiddleware, secret_key=settings.app_secret_key, https_only=False)


@app.on_event("startup")
def _startup() -> None:
    init_db()


def _status() -> dict:
    return {
        "spotify": adapters.spotify.is_authorized(),
        "ytmusic": adapters.youtube.is_authorized(),
        "bandcamp": adapters.bandcamp.is_authorized(),
    }


def _track_sources(db: Session, track_ids: list[int]) -> dict[int, set[str]]:
    if not track_ids:
        return {}
    rows = db.execute(
        select(SourceTrack.track_id, SourceTrack.source).where(SourceTrack.track_id.in_(track_ids))
    ).all()
    out: dict[int, set[str]] = {}
    for tid, src in rows:
        out.setdefault(tid, set()).add(src.value)
    return out


def _track_all_artists(db: Session, track_ids: list[int]) -> dict[int, list[dict]]:
    if not track_ids:
        return {}
    rows = db.scalars(
        select(TrackArtist)
        .where(TrackArtist.track_id.in_(track_ids))
        .order_by(TrackArtist.track_id, TrackArtist.position)
    ).all()
    out: dict[int, list[dict]] = {}
    for ta in rows:
        out.setdefault(ta.track_id, []).append(
            {"name": ta.artist.name, "role": ta.role, "artist_id": ta.artist_id}
        )
    return out


# ----------------------------------------------------------------------------
# Views
# ----------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def index(request: Request, db: Session = Depends(get_db)):
    stats = {
        "tracks": db.scalar(select(func.count(Track.id))) or 0,
        "artists": db.scalar(select(func.count(Artist.id))) or 0,
        "albums": db.scalar(select(func.count(Album.id))) or 0,
        "sources": db.scalar(select(func.count(SourceTrack.id))) or 0,
        "playlists": db.scalar(select(func.count(Playlist.id))) or 0,
        "enriched": db.scalar(select(func.count(Track.id)).where(Track.mbid.isnot(None))) or 0,
        "books": db.scalar(select(func.count(Book.id))) or 0,
        "books_reading": db.scalar(select(func.count(Book.id)).where(Book.reading_status == "reading")) or 0,
        "books_read": db.scalar(select(func.count(Book.id)).where(Book.reading_status == "read")) or 0,
    }
    return TEMPLATES.TemplateResponse(
        request, "index.html", {"status": _status(), "stats": stats}
    )


# ----------------------------------------------------------------------------
# Library: browse by individual artist (disaggregated via TrackArtist)
# ----------------------------------------------------------------------------
@app.get("/library", response_class=HTMLResponse)
def library(request: Request, q: str | None = None, letter: str | None = None, db: Session = Depends(get_db)):
    # available letters from individual artists that have TrackArtist entries
    artist_ids_with_tracks = select(TrackArtist.artist_id).distinct()
    all_letters = db.scalars(
        select(Artist.normalized_name)
        .where(Artist.id.in_(artist_ids_with_tracks))
        .distinct()
        .order_by(Artist.normalized_name)
    ).all()
    used = set()
    for n in all_letters:
        if n and n[0:1].isalpha():
            used.add(n[0].upper())
        else:
            used.add("#")
    letters = sorted(used)

    if not q and not letter and letters:
        letter = letters[0]

    # Find artists matching the filter
    artist_query = select(Artist).where(Artist.id.in_(artist_ids_with_tracks))
    if q:
        like = f"%{q.lower()}%"
        artist_query = artist_query.where(
            func.lower(Artist.name).contains(like, autoescape=False)
        )
    elif letter:
        if letter == "#":
            artist_query = artist_query.where(~Artist.normalized_name.op("GLOB")("[a-zA-Z]*"))
        else:
            artist_query = artist_query.where(Artist.normalized_name.like(f"{letter.lower()}%"))

    artists = db.scalars(artist_query.order_by(Artist.normalized_name)).all()

    # For each artist, get their tracks via TrackArtist, grouped by album
    artist_data = []
    for a in artists:
        tas = db.scalars(
            select(TrackArtist)
            .where(TrackArtist.artist_id == a.id)
            .options(joinedload(TrackArtist.track))
        ).all()
        track_ids = [ta.track_id for ta in tas]
        if not track_ids:
            continue

        sources = _track_sources(db, track_ids)

        # group by album
        albums: dict[str, dict] = {}
        for ta in tas:
            t = ta.track
            album_name = t.album or "—"
            albums.setdefault(album_name, {"tracks": [], "album_id": t.album_id})
            albums[album_name]["tracks"].append({
                "track": t,
                "role": ta.role,
                "sources": sorted(sources.get(t.id, set())),
            })

        n_tracks = len(tas)
        n_albums = len(albums)
        artist_data.append({
            "id": a.id,
            "name": a.name,
            "genres": a.genres,
            "albums": albums,
            "n_albums": n_albums,
            "n_tracks": n_tracks,
        })

    total_tracks = sum(a["n_tracks"] for a in artist_data)

    return TEMPLATES.TemplateResponse(
        request,
        "library.html",
        {
            "artists": artist_data,
            "q": q or "",
            "letter": letter or "",
            "letters": letters,
            "total_tracks": total_tracks,
            "total_artists": len(artist_data),
        },
    )


# ----------------------------------------------------------------------------
# Artist view
# ----------------------------------------------------------------------------
@app.get("/library/artist/{artist_id}", response_class=HTMLResponse)
def artist_view(request: Request, artist_id: int, db: Session = Depends(get_db)):
    artist = db.get(Artist, artist_id)
    if not artist:
        return HTMLResponse("artist not found", status_code=404)

    tas = db.scalars(
        select(TrackArtist)
        .where(TrackArtist.artist_id == artist_id)
        .options(joinedload(TrackArtist.track))
        .order_by(TrackArtist.position)
    ).all()

    track_ids = [ta.track_id for ta in tas]
    sources = _track_sources(db, track_ids)
    all_artists = _track_all_artists(db, track_ids)

    # group by album
    albums: dict[str, dict] = {}
    for ta in tas:
        t = ta.track
        album_name = t.album or "—"
        albums.setdefault(album_name, {"tracks": [], "album_id": t.album_id, "cover_url": None})
        # get album cover
        if t.album_id and not albums[album_name]["cover_url"]:
            album = db.get(Album, t.album_id)
            if album:
                albums[album_name]["cover_url"] = album.cover_url
                albums[album_name]["year"] = album.year
        albums[album_name]["tracks"].append({
            "track": t,
            "role": ta.role,
            "sources": sorted(sources.get(t.id, set())),
            "all_artists": all_artists.get(t.id, []),
        })

    # sort albums by name, tracks by title within album
    sorted_albums = sorted(albums.items(), key=lambda x: x[0])

    return TEMPLATES.TemplateResponse(
        request,
        "artist.html",
        {
            "artist": artist,
            "albums": sorted_albums,
            "n_tracks": len(tas),
            "n_albums": len(albums),
        },
    )


# ----------------------------------------------------------------------------
# Album view
# ----------------------------------------------------------------------------
@app.get("/library/album/{album_id}", response_class=HTMLResponse)
def album_view(request: Request, album_id: int, db: Session = Depends(get_db)):
    album = db.get(Album, album_id)
    if not album:
        return HTMLResponse("album not found", status_code=404)

    tracks = db.scalars(
        select(Track).where(Track.album_id == album_id).order_by(Track.title)
    ).all()
    track_ids = [t.id for t in tracks]
    sources = _track_sources(db, track_ids)
    all_artists = _track_all_artists(db, track_ids)

    track_rows = []
    for t in tracks:
        track_rows.append({
            "track": t,
            "sources": sorted(sources.get(t.id, set())),
            "all_artists": all_artists.get(t.id, []),
        })

    return TEMPLATES.TemplateResponse(
        request,
        "album.html",
        {
            "album": album,
            "tracks": track_rows,
        },
    )


# ----------------------------------------------------------------------------
# Track view
# ----------------------------------------------------------------------------
@app.get("/library/track/{track_id}", response_class=HTMLResponse)
def track_view(request: Request, track_id: int, db: Session = Depends(get_db)):
    track = db.get(Track, track_id)
    if not track:
        return HTMLResponse("track not found", status_code=404)

    tas = db.scalars(
        select(TrackArtist)
        .where(TrackArtist.track_id == track_id)
        .order_by(TrackArtist.position)
    ).all()
    artists = [{"name": ta.artist.name, "role": ta.role, "id": ta.artist_id} for ta in tas]

    srcs = db.scalars(
        select(SourceTrack).where(SourceTrack.track_id == track_id)
    ).all()

    album = db.get(Album, track.album_id) if track.album_id else None

    return TEMPLATES.TemplateResponse(
        request,
        "track.html",
        {
            "track": track,
            "artists": artists,
            "sources": srcs,
            "album": album,
        },
    )


# ----------------------------------------------------------------------------
# Enrichment
# ----------------------------------------------------------------------------
@app.post("/enrich")
def enrich():
    job_id = jobs.start_enrich()
    return RedirectResponse(f"/jobs/{job_id}", status_code=302)


# ----------------------------------------------------------------------------
# Spotify Wrapped / Sound Capsule (read from saved data export)
# ----------------------------------------------------------------------------
@app.get("/wrapped", response_class=HTMLResponse)
def wrapped(request: Request):
    from medialib.core import wrapped as wrapped_mod

    return TEMPLATES.TemplateResponse(
        request,
        "wrapped.html",
        {
            "status": _status(),
            "available": wrapped_mod.is_available(),
            "wrapped": wrapped_mod.load_wrapped() if wrapped_mod.is_available() else None,
            "capsule": wrapped_mod.load_capsule() if wrapped_mod.is_available() else None,
        },
    )


# ----------------------------------------------------------------------------
# Background jobs: progress + status
# ----------------------------------------------------------------------------
@app.get("/jobs/{job_id}", response_class=HTMLResponse)
def job_progress(request: Request, job_id: int, db: Session = Depends(get_db)):
    job = db.get(ImportJob, job_id)
    if not job:
        return TEMPLATES.TemplateResponse(request, "progress.html", {"job": None})
    return TEMPLATES.TemplateResponse(request, "progress.html", {"job": job})


@app.get("/jobs/{job_id}/status", response_class=HTMLResponse)
def job_status(request: Request, job_id: int, db: Session = Depends(get_db)):
    job = db.get(ImportJob, job_id)
    if not job:
        return HTMLResponse("not found", status_code=404)
    return TEMPLATES.TemplateResponse(request, "progress_fragment.html", {"job": job})


# ----------------------------------------------------------------------------
# Spotify auth + import
# ----------------------------------------------------------------------------
@app.get("/auth/spotify")
def auth_spotify():
    return RedirectResponse(adapters.spotify.auth_url())


@app.get("/callback/spotify")
def callback_spotify(code: str | None = None, error: str | None = None):
    if error:
        return RedirectResponse(f"/?spotify_error={error}", status_code=302)
    if not code:
        return RedirectResponse("/?spotify_error=no_code", status_code=302)
    adapters.spotify.handle_callback(code)
    return RedirectResponse("/?spotify=connected", status_code=302)


@app.post("/import/spotify/saved")
def import_spotify_saved():
    if not adapters.spotify.is_authorized():
        return RedirectResponse("/?error=spotify_not_authorized", status_code=302)
    job_id = jobs.start_spotify_saved()
    return RedirectResponse(f"/jobs/{job_id}", status_code=302)


@app.post("/import/spotify/playlists")
def import_spotify_playlists():
    if not adapters.spotify.is_authorized():
        return RedirectResponse("/?error=spotify_not_authorized", status_code=302)
    job_id = jobs.start_spotify_playlists()
    return RedirectResponse(f"/jobs/{job_id}", status_code=302)


# ----------------------------------------------------------------------------
# Bandcamp import
# ----------------------------------------------------------------------------
@app.post("/import/bandcamp")
def import_bandcamp():
    if not adapters.bandcamp.is_authorized():
        return RedirectResponse("/?error=bandcamp_no_cookie", status_code=302)
    job_id = jobs.start_bandcamp()
    return RedirectResponse(f"/jobs/{job_id}", status_code=302)


# ----------------------------------------------------------------------------
# Migrate to YouTube Music
# ----------------------------------------------------------------------------
@app.get("/migrate", response_class=HTMLResponse)
def migrate_form(request: Request, db: Session = Depends(get_db)):
    playlists = db.scalars(select(Playlist).order_by(Playlist.name)).all()
    return TEMPLATES.TemplateResponse(
        request,
        "migrate.html",
        {"status": _status(), "playlists": playlists},
    )


@app.post("/migrate/preview", response_class=HTMLResponse)
def migrate_preview(
    request: Request,
    playlist_id: int | None = Form(None),
    db: Session = Depends(get_db),
):
    if not adapters.youtube.is_authorized():
        return RedirectResponse("/?error=ytmusic_not_authorized", status_code=302)

    from medialib.adapters import youtube
    from medialib.core.match import TrackKey

    if playlist_id:
        track_ids = [
            r[0]
            for r in db.execute(
                select(PlaylistTrack.track_id).where(PlaylistTrack.playlist_id == playlist_id)
            )
        ]
    else:
        track_ids = db.scalars(select(Track.id)).all()

    preview = []
    for tid in track_ids[:200]:
        t = db.get(Track, tid)
        if not t:
            continue
        # get primary artist name from TrackArtist
        primary_ta = db.scalars(
            select(TrackArtist).where(TrackArtist.track_id == tid).order_by(TrackArtist.position).limit(1)
        ).first()
        artist_name = primary_ta.artist.name if primary_ta else "Unknown"
        key = TrackKey(title=t.title, artist=artist_name, duration_ms=t.duration_ms, isrc=t.isrc)
        try:
            cands = youtube.search_track(key, limit=5)
            best = youtube.best_match(cands, key)
        except Exception as e:  # noqa: BLE001
            preview.append({"track": t, "error": str(e)})
            continue
        preview.append({"track": t, "best": best, "candidates": cands})
    return TEMPLATES.TemplateResponse(request, "preview.html", {"preview": preview})


@app.post("/migrate/run")
def migrate_run(
    playlist_id: int | None = Form(None),
    target_name: str = Form(...),
):
    if not adapters.youtube.is_authorized():
        return RedirectResponse("/?error=ytmusic_not_authorized", status_code=302)
    job_id = jobs.start_migrate(playlist_id, target_name)
    return RedirectResponse(f"/jobs/{job_id}", status_code=302)


# ----------------------------------------------------------------------------
# Books
# ----------------------------------------------------------------------------
@app.get("/books", response_class=HTMLResponse)
def books_list(request: Request, q: str | None = None, letter: str | None = None, db: Session = Depends(get_db)):
    # letters
    all_letters = db.scalars(
        select(Book.normalized_title).distinct().order_by(Book.normalized_title)
    ).all()
    used = set()
    for n in all_letters:
        if n and n[0:1].isalpha():
            used.add(n[0].upper())
        else:
            used.add("#")
    letters = sorted(used)

    if not q and not letter and letters:
        letter = letters[0]

    query = select(Book)
    if q:
        like = f"%{q.lower()}%"
        query = query.where(func.lower(Book.title).contains(like, autoescape=False))
    elif letter:
        if letter == "#":
            query = query.where(~Book.normalized_title.op("GLOB")("[a-zA-Z]*"))
        else:
            query = query.where(Book.normalized_title.like(f"{letter.lower()}%"))

    books = db.scalars(query.order_by(Book.normalized_title)).all()

    # bulk-load authors
    book_ids = [b.id for b in books]
    author_links: dict[int, list[BookAuthor]] = {}
    if book_ids:
        links = db.scalars(
            select(BookAuthorLink)
            .where(BookAuthorLink.book_id.in_(book_ids))
            .order_by(BookAuthorLink.book_id, BookAuthorLink.position)
        ).all()
        for link in links:
            author_links.setdefault(link.book_id, []).append(link.author)

    return TEMPLATES.TemplateResponse(
        request,
        "books.html",
        {
            "books": books,
            "author_links": author_links,
            "q": q or "",
            "letter": letter or "",
            "letters": letters,
            "total": len(books),
        },
    )


@app.get("/books/{book_id}", response_class=HTMLResponse)
def book_detail(request: Request, book_id: int, db: Session = Depends(get_db)):
    book = db.get(Book, book_id)
    if not book:
        return HTMLResponse("book not found", status_code=404)
    links = db.scalars(
        select(BookAuthorLink)
        .where(BookAuthorLink.book_id == book_id)
        .order_by(BookAuthorLink.position)
    ).all()
    authors = [link.author for link in links]
    return TEMPLATES.TemplateResponse(
        request, "book_detail.html", {"book": book, "authors": authors}
    )


@app.post("/books/{book_id}/status")
def update_reading_status(
    book_id: int,
    status: str = Form(...),
    db: Session = Depends(get_db),
):
    book = db.get(Book, book_id)
    if book:
        book.reading_status = status if status != "none" else None
        db.commit()
    return RedirectResponse(f"/books/{book_id}", status_code=302)


@app.post("/books/{book_id}/rating")
def update_rating(
    book_id: int,
    rating: int = Form(...),
    db: Session = Depends(get_db),
):
    book = db.get(Book, book_id)
    if book and 0 <= rating <= 5:
        book.rating = rating if rating > 0 else None
        db.commit()
    return RedirectResponse(f"/books/{book_id}", status_code=302)


@app.post("/books/import/epub")
async def import_epub(file: UploadFile = File(...), db: Session = Depends(get_db)):
    from medialib.adapters.epub import parse_epub
    from medialib.core.book_catalog import upsert_book
    from medialib.adapters.openlibrary import cover_url

    import tempfile, os

    # save to temp file
    suffix = os.path.splitext(file.filename or "book.epub")[1] or ".epub"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        meta = parse_epub(tmp_path)
        if not meta or not meta.get("title"):
            return RedirectResponse("/books?error=epub_parse_failed", status_code=302)

        book = upsert_book(
            db,
            title=meta["title"],
            authors=meta.get("authors", ["Unknown"]),
            isbn=meta.get("isbn"),
            publisher=meta.get("publisher"),
            year=meta.get("year"),
            description=meta.get("description"),
        )

        # try cover from Open Library if no cover yet
        if not book.cover_url and book.isbn:
            book.cover_url = cover_url(isbn=book.isbn)

        db.commit()
        return RedirectResponse(f"/books/{book.id}", status_code=302)
    finally:
        os.unlink(tmp_path)


@app.post("/books/import/isbn")
def import_isbn(isbn: str = Form(...), db: Session = Depends(get_db)):
    from medialib.adapters.openlibrary import search_by_isbn
    from medialib.core.book_catalog import upsert_book

    result = search_by_isbn(isbn)
    if not result:
        return RedirectResponse(f"/books?error=isbn_not_found&isbn={isbn}", status_code=302)

    book = upsert_book(
        db,
        title=result["title"],
        authors=[a["name"] for a in result.get("authors", [])],
        isbn=result.get("isbn"),
        publisher=result.get("publisher"),
        year=result.get("year"),
        cover_url=result.get("cover_url"),
        description=result.get("description"),
        page_count=result.get("page_count"),
        olid=result.get("olid"),
    )
    db.commit()
    return RedirectResponse(f"/books/{book.id}", status_code=302)


@app.post("/books/enrich")
def enrich_books():
    job_id = jobs.start_book_enrich()
    return RedirectResponse(f"/jobs/{job_id}", status_code=302)
