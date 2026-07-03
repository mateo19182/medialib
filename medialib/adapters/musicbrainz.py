from __future__ import annotations

import logging
import time
import re

import httpx

logger = logging.getLogger(__name__)

_BASE = "https://musicbrainz.org/ws/2"
_COVER = "https://coverartarchive.org"
_USER_AGENT = "medialib/0.1 (self-hosted music catalog manager)"

_last_request_time = 0.0


def _rate_limit() -> None:
    global _last_request_time
    elapsed = time.time() - _last_request_time
    if elapsed < 1.1:
        time.sleep(1.1 - elapsed)
    _last_request_time = time.time()


def _get(path: str, params: dict | None = None) -> dict | None:
    _rate_limit()
    headers = {"User-Agent": _USER_AGENT, "Accept": "application/json"}
    url = f"{_BASE}/{path.lstrip('/')}"
    try:
        with httpx.Client(headers=headers, timeout=15, follow_redirects=True) as cx:
            if params:
                # build query string manually to preserve + separators
                query = "&".join(f"{k}={v}" for k, v in params.items())
                r = cx.get(f"{url}?{query}")
            else:
                r = cx.get(url)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()
    except Exception as e:
        logger.warning("musicbrainz request failed: %s", e)
        return None


def lookup_isrc(isrc: str) -> dict | None:
    """Look up a recording by ISRC. Returns artist credits, releases (with release groups)."""
    if not isrc:
        return None
    isrc = isrc.strip().upper()
    data = _get(
        f"isrc/{isrc}",
        params={"inc": "artist-credits+releases", "fmt": "json"},
    )
    if not data or not data.get("recordings"):
        return None
    rec = data["recordings"][0]
    return _parse_recording(rec)


def search_recording(title: str, artist: str) -> dict | None:
    """Search MusicBrainz for a recording by title + artist. Fallback when ISRC lookup fails."""
    query = f"recording:\"{title}\" AND artist:\"{artist}\""
    data = _get(
        "recording",
        params={"query": query, "limit": 1, "fmt": "json"},
    )
    if not data or not data.get("recordings"):
        return None
    rec = data["recordings"][0]
    return _parse_recording(rec)


def _parse_recording(rec: dict) -> dict:
    """Extract structured data from a MusicBrainz recording."""
    artists = []
    for credit in rec.get("artist-credit", []):
        if "artist" in credit:
            artists.append(
                {
                    "name": credit["artist"].get("name", ""),
                    "mbid": credit["artist"].get("id", ""),
                    "join_phrase": credit.get("joinphrase", ""),
                }
            )

    # Extract release groups from releases
    release_groups = []
    seen_rg_ids = set()
    for release in rec.get("releases", []):
        rg = release.get("release-group")
        if rg and rg.get("id") not in seen_rg_ids:
            seen_rg_ids.add(rg.get("id"))
            release_groups.append(
                {
                    "mbid": rg.get("id", ""),
                    "title": rg.get("title", ""),
                    "type": rg.get("primary-type", ""),
                    "year": _extract_year(rg.get("first-release-date", "")),
                }
            )

    genres = []
    for g in rec.get("genres", []):
        genres.append(g.get("name", ""))
    if not genres:
        for t in rec.get("tags", []):
            genres.append(t.get("name", ""))

    return {
        "recording_mbid": rec.get("id", ""),
        "title": rec.get("title", ""),
        "length": rec.get("length"),
        "artists": artists,
        "release_groups": release_groups[:3],
        "genres": genres[:5],
    }


def _extract_year(date_str: str) -> int | None:
    if not date_str:
        return None
    m = re.match(r"(\d{4})", date_str)
    return int(m.group(1)) if m else None


def get_cover_art(release_group_mbid: str, size: int = 500) -> str | None:
    """Fetch cover art URL from Cover Art Archive for a release group."""
    if not release_group_mbid:
        return None
    _rate_limit()
    try:
        with httpx.Client(timeout=10, follow_redirects=False) as cx:
            r = cx.head(f"{_COVER}/release-group/{release_group_mbid}/front-{size}")
            if r.status_code in (307, 302, 301):
                return r.headers.get("location")
            if r.status_code == 200:
                return str(r.url)
    except Exception as e:
        logger.debug("cover art lookup failed for %s: %s", release_group_mbid, e)
    return None


def search_artist(name: str) -> dict | None:
    """Search for an artist by name, return first match with MBID."""
    data = _get(
        "artist",
        params={"query": name, "limit": 1, "fmt": "json"},
    )
    if not data or not data.get("artists"):
        return None
    a = data["artists"][0]
    return {
        "mbid": a.get("id", ""),
        "name": a.get("name", ""),
        "country": a.get("country", ""),
        "genres": [g.get("name", "") for g in a.get("genres", [])[:3]],
    }
