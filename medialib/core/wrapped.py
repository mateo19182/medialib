"""Read & present Spotify Wrapped + Sound Capsule from a saved data export.

The Wrapped export stores its top artists / albums / tracks as opaque
``spotify:...`` URIs. We resolve those to human names + cover art via the
Spotify Web API (the app is already authorized for imports) and cache the
resolved metadata to disk so it only happens once. If Spotify isn't connected
the page still renders, just with plain Spotify links instead of names/art.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from medialib.config import ROOT

logger = logging.getLogger(__name__)

EXPORT_DIR = ROOT / "data" / "spotify_export"
ACCOUNT_DIR = EXPORT_DIR / "Spotify Account Data"
_CACHE_PATH = EXPORT_DIR / ".uri_names.json"

_MONTHS = [
    "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
    "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
]


# ---------------------------------------------------------------------------
# low-level helpers
# ---------------------------------------------------------------------------
def _uri_id(uri: str) -> str:
    return uri.rsplit(":", 1)[-1] if uri else ""


def _uri_kind(uri: str) -> str:
    parts = (uri or "").split(":")
    return parts[1] if len(parts) >= 3 else ""


def _open_url(uri: str) -> str:
    kind, _id = _uri_kind(uri), _uri_id(uri)
    return f"https://open.spotify.com/{kind}/{_id}" if kind and _id else "#"


def _load_json(path: Path):
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("wrapped: could not read %s: %s", path, e)
        return None


def is_available() -> bool:
    return (ACCOUNT_DIR / "Wrapped2025.json").exists()


# ---------------------------------------------------------------------------
# URI resolution (Spotify API + on-disk cache)
# ---------------------------------------------------------------------------
def _load_cache() -> dict:
    if not _CACHE_PATH.exists():
        return {}
    data = _load_json(_CACHE_PATH)
    return data if isinstance(data, dict) else {}


def _save_cache(cache: dict) -> None:
    try:
        _CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    except OSError as e:
        logger.warning("wrapped: could not write uri cache: %s", e)


def _resolve_uris(uris: list[str]) -> dict[str, dict]:
    """Return {uri: {name, subtitle, image, url}} for every uri, resolving any
    that aren't cached yet via Spotify's public oEmbed endpoint (no auth needed).
    Track subtitles (artist names) are filled from the streaming history.
    Always returns an entry per uri, falling back to the bare id + open.spotify
    link when a lookup fails."""
    cache = _load_cache()
    wanted = {u for u in uris if u}
    missing = [u for u in wanted if u not in cache]

    if missing:
        subtitles = _history_track_meta([u for u in missing if _uri_kind(u) == "track"])
        for u in missing:
            meta = _oembed(u)
            if meta is None:
                continue
            meta["subtitle"] = subtitles.get(u, meta.get("subtitle", ""))
            cache[u] = meta
        _save_cache(cache)

    out: dict[str, dict] = {}
    for u in wanted:
        out[u] = cache.get(u) or {
            "name": _uri_id(u),
            "subtitle": "",
            "image": None,
            "url": _open_url(u),
        }
    return out


def _oembed(uri: str) -> dict | None:
    """Resolve a single Spotify URI to name + thumbnail via public oEmbed."""
    import requests

    url = _open_url(uri)
    try:
        r = requests.get("https://open.spotify.com/oembed", params={"url": url}, timeout=15)
        if not r.ok:
            return None
        d = r.json()
    except Exception as e:
        logger.warning("wrapped: oembed failed for %s: %s", uri, e)
        return None
    return {
        "name": d.get("title") or _uri_id(uri),
        "subtitle": "",
        "image": d.get("thumbnail_url"),
        "url": url,
    }


def _history_track_meta(track_uris: list[str]) -> dict[str, str]:
    """Map track URI -> "artist · album" by scanning the extended streaming
    history (which stores readable names keyed by spotify_track_uri)."""
    wanted = set(track_uris)
    if not wanted:
        return {}
    hist_dir = EXPORT_DIR / "Spotify Extended Streaming History"
    found: dict[str, str] = {}
    try:
        files = sorted(hist_dir.glob("Streaming_History_Audio_*.json"))
    except OSError:
        return {}
    for f in files:
        if len(found) >= len(wanted):
            break
        data = _load_json(f)
        if not isinstance(data, list):
            continue
        for rec in data:
            uri = rec.get("spotify_track_uri")
            if uri in wanted and uri not in found:
                artist = rec.get("master_metadata_album_artist_name") or ""
                album = rec.get("master_metadata_album_album_name") or ""
                found[uri] = " · ".join(x for x in (artist, album) if x)
                if len(found) >= len(wanted):
                    break
    return found


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
def load_wrapped() -> dict | None:
    """Parse Wrapped2025.json into a template-ready structure, or None if
    the export isn't present."""
    raw = _load_json(ACCOUNT_DIR / "Wrapped2025.json")
    if not raw:
        return None

    top_artists = raw.get("topArtists", {})
    top_tracks = raw.get("topTracks", {})
    top_albums = raw.get("topAlbums", {})
    top_pods = raw.get("topPodcasts", {})
    metrics = raw.get("yearlyMetrics", {})
    age = raw.get("listeningAge", {})
    clubs = raw.get("clubs", {})
    party = raw.get("party", {})

    artist_uris = top_artists.get("topArtistUris", []) or []
    album_uris = top_albums.get("topAlbums", []) or []
    track_entries = top_tracks.get("topTracks", []) or []
    track_uris = [t.get("trackUri") for t in track_entries]
    pod_uris = top_pods.get("topPodcastsUri", []) or []

    resolved = _resolve_uris(artist_uris + album_uris + track_uris + pod_uris)

    def card(uri):
        return {"uri": uri, **resolved.get(uri, {"name": _uri_id(uri), "subtitle": "", "image": None, "url": _open_url(uri)})}

    ms = metrics.get("totalMsListened", 0) or 0
    result = {
        "year": 2025,
        "total_minutes": round(ms / 60000),
        "total_hours": round(ms / 3_600_000),
        "num_unique_artists": top_artists.get("numUniqueArtists"),
        "num_unique_tracks": top_tracks.get("numUniqueTracks"),
        "num_completed_albums": top_albums.get("numCompletedAlbums"),
        "top_fan_percentile": top_artists.get("topNPercentileFan"),
        "num_genres": raw.get("topGenres", {}).get("totalNumGenres"),
        "listening_age": {
            "age": age.get("listeningAge"),
            "start_year": age.get("windowStartYear"),
            "phase": (age.get("decadePhase") or "").replace("_", " ").title(),
        } if age else None,
        "club": {
            "name": (clubs.get("userClub") or "").replace("_", " ").title(),
            "role": (clubs.get("role") or "").replace("_", " ").title(),
            "percent": clubs.get("percentInClub"),
        } if clubs.get("userClub") else None,
        "top_artists": [card(u) for u in artist_uris],
        "top_albums": [card(u) for u in album_uris],
        "top_tracks": [
            {**card(t.get("trackUri")), "count": t.get("count"), "ms": t.get("msPlayed")}
            for t in track_entries
        ],
        "top_podcasts": [card(u) for u in pod_uris],
        "podcast_hours": round((top_pods.get("topPodcastMilliseconds") or 0) / 3_600_000),
        "party": _party_facts(party),
        "artist_race": _artist_race(raw.get("topArtistRace", {}), resolved, artist_uris),
    }
    return result


def _party_facts(party: dict) -> list[dict]:
    """Pick the readable, human-interesting numbers out of the `party` blob."""
    if not party:
        return []
    facts = []

    def add(label, value):
        if value is not None:
            facts.append({"label": label, "value": value})

    pop = party.get("avgTrackPopularityScore")
    add("Avg track popularity", f"{round(pop * 100)}%" if pop is not None else None)
    expl = party.get("percentListenedExplicit")
    add("Explicit tracks", f"{round(expl)}%" if expl is not None else None)
    add("Albums listened", party.get("numListenedAlbums"))
    add("Content shared", party.get("numSharesAllContent"))
    news = party.get("numMinsPlayedNews")
    add("Minutes of news", f"{news:,}" if news else None)
    chaos = party.get("absoluteChaosRankingScore")
    add("Chaos score", round(chaos) if chaos is not None else None)
    return facts


def _artist_race(race: dict, resolved: dict, artist_uris: list[str]) -> list[dict]:
    """Monthly rank of each top artist across the year (for a small chart)."""
    out = []
    for a in (race.get("topArtists") or []):
        uri = a.get("artistUri")
        meta = resolved.get(uri) or {}
        ranks = {m.get("month"): m.get("rank") for m in (a.get("monthsStats") or [])}
        out.append({
            "name": meta.get("name") or _uri_id(uri),
            "url": meta.get("url") or _open_url(uri),
            "ranks": [ranks.get(m) for m in _MONTHS],
        })
    return out


def load_capsule() -> dict | None:
    """Parse YourSoundCapsule.json — recent daily listening + highlight events."""
    raw = _load_json(ACCOUNT_DIR / "YourSoundCapsule.json")
    if not raw:
        return None
    stats = raw.get("stats", []) or []
    highlights = raw.get("highlights", []) or []

    days = []
    for s in stats:
        days.append({
            "date": s.get("date"),
            "minutes": round((s.get("secondsPlayed") or 0) / 60),
            "streams": s.get("streamCount"),
            "top_track": (s.get("topTracks") or [{}])[0].get("name"),
        })
    days.sort(key=lambda d: d["date"] or "", reverse=True)

    hi = []
    for h in highlights:
        htype = (h.get("highlightType") or "").replace("_", " ").title()
        detail = ""
        for k, v in h.items():
            if isinstance(v, dict):
                ent = v.get("entity")
                num = v.get("dayStreaks") or v.get("count") or v.get("streamCount")
                detail = " · ".join(str(x) for x in (ent, num) if x is not None)
        hi.append({"date": h.get("date"), "type": htype, "detail": detail})
    hi.sort(key=lambda d: d["date"] or "", reverse=True)

    total_min = sum(d["minutes"] for d in days)
    return {"days": days, "highlights": hi, "total_minutes": total_min}
