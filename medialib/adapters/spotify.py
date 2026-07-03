from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Callable, Iterator, TypeVar

import requests
import spotipy
from spotipy import SpotifyOAuth

from medialib.config import ROOT, settings

logger = logging.getLogger(__name__)

_CACHE = ROOT / "data" / ".spotify_cache"

T = TypeVar("T")


def _with_retry(
    fn: Callable[..., T], *args, max_retries: int = 5, base_delay: float = 1.0, **kwargs
) -> T:
    last: Exception | None = None
    for attempt in range(max_retries):
        try:
            return fn(*args, **kwargs)
        except requests.exceptions.RequestException as e:
            last = e
            delay = min(base_delay * (2**attempt), 30.0)
            logger.warning(
                "spotify request failed (attempt %d/%d): %s; retrying in %.1fs",
                attempt + 1,
                max_retries,
                e,
                delay,
            )
            time.sleep(delay)
    assert last is not None
    raise last


def oauth() -> SpotifyOAuth:
    return SpotifyOAuth(
        client_id=settings.spotipy_client_id,
        client_secret=settings.spotipy_client_secret,
        redirect_uri=settings.spotipy_redirect_uri,
        scope=settings.spotify_scopes,
        cache_handler=spotipy.cache_handler.CacheFileHandler(cache_path=str(_CACHE)),
    )


def auth_url() -> str:
    return oauth().get_authorize_url()


def handle_callback(code: str) -> dict:
    return oauth().get_access_token(code, as_dict=True, check_cache=False)


def client() -> spotipy.Spotify:
    return spotipy.Spotify(
        auth_manager=oauth(),
        requests_timeout=30,
        retries=5,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
    )


def saved_tracks_total(sp: spotipy.Spotify) -> int:
    r = _with_retry(sp.current_user_saved_tracks, limit=1)
    return r.get("total", 0) if r else 0


def playlists_total(sp: spotipy.Spotify) -> int:
    r = _with_retry(sp.current_user_playlists, limit=1)
    return r.get("total", 0) if r else 0


def is_authorized() -> bool:
    try:
        tok = oauth().get_cached_token()
        return bool(tok)
    except Exception:
        return False


def _artist_names(artists: list[dict]) -> str:
    return ", ".join(a["name"] for a in (artists or [])) or "Unknown"


def iter_saved_tracks(sp: spotipy.Spotify) -> Iterator[dict]:
    results = _with_retry(sp.current_user_saved_tracks, limit=50)
    while results:
        for item in results["items"]:
            t = item.get("track") or {}
            if not t.get("id"):
                continue
            yield {
                "source_id": t["id"],
                "title": t.get("name", ""),
                "artist": _artist_names(t.get("artists")),
                "album": (t.get("album") or {}).get("name"),
                "duration_ms": t.get("duration_ms"),
                "isrc": ((t.get("external_ids") or {}).get("isrc")),
            }
        results = _with_retry(sp.next, results) if results.get("next") else None


def iter_playlists(sp: spotipy.Spotify) -> Iterator[dict]:
    results = _with_retry(sp.current_user_playlists, limit=50)
    while results:
        for pl in results["items"]:
            if not pl.get("id"):
                continue
            yield {
                "source_playlist_id": pl["id"],
                "name": pl.get("name", "Untitled"),
                "owner": (pl.get("owner") or {}).get("display_name"),
                "tracks_total": pl.get("tracks", {}).get("total", 0),
            }
        results = _with_retry(sp.next, results) if results.get("next") else None


def iter_playlist_tracks(sp: spotipy.Spotify, playlist_id: str) -> Iterator[dict]:
    results = _with_retry(sp.playlist_tracks, playlist_id, limit=100)
    while results:
        for item in results["items"]:
            t = (item.get("track") or {})
            if not t.get("id"):
                continue
            yield {
                "source_id": t["id"],
                "title": t.get("name", ""),
                "artist": _artist_names(t.get("artists")),
                "album": (t.get("album") or {}).get("name"),
                "duration_ms": t.get("duration_ms"),
                "isrc": ((t.get("external_ids") or {}).get("isrc")),
            }
        results = _with_retry(sp.next, results) if results.get("next") else None
