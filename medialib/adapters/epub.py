from __future__ import annotations

import logging
import re
from pathlib import Path

from ebooklib import epub

logger = logging.getLogger(__name__)


def parse_epub(file_path: str | Path) -> dict:
    """Parse metadata from an EPUB file."""
    try:
        book = epub.read_epub(str(file_path), options={"ignore_ncx": True})
    except Exception as e:
        logger.warning("failed to read epub %s: %s", file_path, e)
        return {}

    metadata = book.metadata
    title = _get_meta(metadata, "title") or Path(file_path).stem
    creators = _get_all_meta(metadata, "creator") or []
    isbn = _find_isbn(metadata)
    publisher = _get_meta(metadata, "publisher")
    date = _get_meta(metadata, "date") or ""
    year = _extract_year(date)
    description = _get_meta(metadata, "description")

    # try to extract cover image
    cover_url = None
    for item in book.get_items_of_type(epub.ITEM_COVER):
        cover_url = item.get_name()
        break

    return {
        "title": title,
        "authors": creators,
        "isbn": isbn,
        "publisher": publisher,
        "year": year,
        "description": description,
        "cover_ref": cover_url,
    }


def _get_meta(metadata: dict, field: str) -> str | None:
    for ns in ("http://purl.org/dc/elements/1.1/", "http://idpf.org/epub/ns/"):
        val = metadata.get(ns, {}).get(field)
        if val:
            return val[0][0]
    return None


def _get_all_meta(metadata: dict, field: str) -> list[str]:
    for ns in ("http://purl.org/dc/elements/1.1/", "http://idpf.org/epub/ns/"):
        val = metadata.get(ns, {}).get(field)
        if val:
            return [v[0] for v in val]
    return []


def _find_isbn(metadata: dict) -> str | None:
    for ns in ("http://purl.org/dc/elements/1.1/", "http://idpf.org/epub/ns/"):
        ids = metadata.get(ns, {}).get("identifier", [])
        for val, attrs in ids:
            scheme = attrs.get("id", "").lower()
            if "isbn" in scheme or "isbn" in val.lower():
                return re.sub(r"[^0-9X]", "", val.upper())
            if re.match(r"^[0-9]{10,13}[X]?$", val.strip()):
                return re.sub(r"[^0-9X]", "", val.upper())
    return None


def _extract_year(date: str) -> int | None:
    if not date:
        return None
    m = re.match(r"(\d{4})", date)
    return int(m.group(1)) if m else None
