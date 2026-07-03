from __future__ import annotations

from typing import Iterator

from medialib.config import settings
from medialib.core.match import TrackKey

_client = None


def _client():
    global _client
    if _client is not None:
        return _client
    from ytmusicapi import YTMusic

    path = settings.ytmusic_headers_abs
    if not path.exists():
        raise RuntimeError(
            f"ytmusic headers not found at {path}. Run: ytmusicapi setup oauth"
        )
    _client = YTMusic(str(path))
    return _client


def is_authorized() -> bool:
    try:
        return settings.ytmusic_headers_abs.exists()
    except Exception:
        return False


def search_track(key: TrackKey, limit: int = 5) -> list[dict]:
    """Search YouTube Music for a track and return candidate video entries."""
    yt = _client()
    query = f"{key.artist} {key.title}"
    res = yt.search(query, filter="songs", limit=limit) or []
    out = []
    for r in res:
        out.append(
            {
                "video_id": r.get("videoId"),
                "title": r.get("title"),
                "artist": (r.get("artists") or [{}])[0].get("name", "")
                if r.get("artists")
                else "",
                "album": (r.get("album") or {}).get("name") if isinstance(r.get("album"), dict) else r.get("album"),
                "duration_ms": _dur_to_ms(r.get("duration")),
            }
        )
    return out


def _dur_to_ms(dur) -> int | None:
    if not dur or not isinstance(dur, str) or ":" not in dur:
        return None
    parts = dur.split(":")
    try:
        if len(parts) == 2:
            return (int(parts[0]) * 60 + int(parts[1])) * 1000
        return (int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])) * 1000
    except ValueError:
        return None


def create_playlist(name: str, description: str = "") -> str:
    yt = _client()
    return yt.create_playlist(title=name, description=description)


def add_tracks(playlist_id: str, video_ids: list[str]) -> dict:
    yt = _client()
    return yt.add_playlist_items(playlist_id, video_ids)


def best_match(candidates: list[dict], key: TrackKey) -> dict | None:
    from medialib.core.match import fuzzy_score

    best, best_score = None, 0
    for c in candidates:
        if not c.get("video_id"):
            continue
        ck = TrackKey(
            title=c.get("title", ""),
            artist=c.get("artist", ""),
            duration_ms=c.get("duration_ms"),
        )
        s = fuzzy_score(key, ck)
        if s > best_score:
            best, best_score = c, s
    return best
