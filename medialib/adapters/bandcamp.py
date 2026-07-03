from __future__ import annotations

from typing import Iterator

import httpx

from medialib.config import settings

_BASE = "https://bandcamp.com"


def is_authorized() -> bool:
    return bool(settings.bandcamp_cookie)


def fetch_collection(fan_id: str | None = None) -> Iterator[dict]:
    """Yield items from your Bandcamp collection via the hidden JSON API.

    Requires a logged-in session cookie (set BANDCAMP_COOKIE in .env).
    If fan_id is unknown, the collection page HTML is fetched first to discover it.
    """
    if not is_authorized():
        raise RuntimeError("BANDCAMP_COOKIE not set in .env")

    headers = {
        "Cookie": settings.bandcamp_cookie,
        "User-Agent": "Mozilla/5.0 (compatible; medialib/0.1)",
        "Accept": "application/json",
    }

    with httpx.Client(headers=headers, follow_redirects=True, timeout=30) as cx:
        if not fan_id:
            fan_id = _discover_fan_id(cx)
        if not fan_id:
            return

        count = 100
        older_than_token = None
        while True:
            body = {"fan_id": int(fan_id), "count": count}
            if older_than_token:
                body["older_than_token"] = older_than_token
            r = cx.post(f"{_BASE}/api/fancollection/1/collection_items", json=body)
            r.raise_for_status()
            data = r.json()
            items = data.get("items") or []
            for it in items:
                yield _normalize(it)
            # pagination token
            older_than_token = data.get("last_token")
            if not older_than_token or len(items) < count:
                break


def _discover_fan_id(cx: httpx.Client) -> str | None:
    import re

    r = cx.get(f"{_BASE}/collection")
    if r.status_code != 200:
        return None
    m = re.search(r'"fan_id"\s*:\s*(\d+)', r.text)
    return m.group(1) if m else None


def _normalize(it: dict) -> dict:
    return {
        "source_id": str(it.get("item_id") or it.get("sale_id") or ""),
        "title": it.get("item_name") or it.get("track_title") or "",
        "artist": it.get("band_name") or "",
        "album": it.get("album_name") or it.get("item_name"),
        "duration_ms": None,
        "isrc": None,
        "url": it.get("item_url") or it.get("url"),
        "raw": it,
    }
