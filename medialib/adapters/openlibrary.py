from __future__ import annotations

import logging
import re

import httpx

logger = logging.getLogger(__name__)

_BASE = "https://openlibrary.org"
_COVERS = "https://covers.openlibrary.org/b"


def _normalize_isbn(isbn: str) -> str:
    return re.sub(r"[^0-9X]", "", isbn.upper())


def search_by_isbn(isbn: str) -> dict | None:
    """Look up a book by ISBN via Open Library."""
    isbn = _normalize_isbn(isbn)
    if not isbn:
        return None
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as cx:
            r = cx.get(f"{_BASE}/api/books", params={"bibkeys": f"ISBN:{isbn}", "format": "json", "jscmd": "data"})
            r.raise_for_status()
            data = r.json()
            key = f"ISBN:{isbn}"
            if key not in data:
                return None
            return _parse_ol_book(data[key], isbn)
    except Exception as e:
        logger.warning("openlibrary isbn lookup failed: %s", e)
        return None


def search_by_title(title: str, author: str | None = None, limit: int = 5) -> list[dict]:
    """Search Open Library for books by title (+ optional author)."""
    params = {"title": title, "limit": limit, "fields": "key,title,author_name,first_publish_year,isbn,cover_i"}
    if author:
        params["author"] = author
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as cx:
            r = cx.get(f"{_BASE}/search.json", params=params)
            r.raise_for_status()
            data = r.json()
            results = []
            for doc in data.get("docs", [])[:limit]:
                results.append(_parse_ol_search(doc))
            return results
    except Exception as e:
        logger.warning("openlibrary search failed: %s", e)
        return []


def author_by_olid(olid: str) -> dict | None:
    """Fetch author details by OLID."""
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as cx:
            r = cx.get(f"{_BASE}/authors/{olid}.json")
            if r.status_code == 404:
                return None
            r.raise_for_status()
            data = r.json()
            return {
                "olid": olid,
                "name": data.get("name", ""),
                "bio": data.get("bio", ""),
            }
    except Exception as e:
        logger.warning("openlibrary author lookup failed: %s", e)
        return None


def cover_url(isbn: str | None = None, olid: str | None = None, size: str = "M") -> str | None:
    """Build a cover image URL from ISBN or OLID."""
    if isbn:
        isbn = _normalize_isbn(isbn)
        return f"{_COVERS}/isbn/{isbn}-{size}.jpg"
    if olid:
        return f"{_COVERS}/olid/{olid}-{size}.jpg"
    return None


def _parse_ol_book(data: dict, isbn: str) -> dict:
    authors = []
    for a in data.get("authors", []):
        authors.append({"name": a.get("name", ""), "olid": (a.get("key", "") or "").replace("/authors/", "")})
    return {
        "title": data.get("title", ""),
        "isbn": isbn,
        "olid": (data.get("key", "") or "").replace("/books/", ""),
        "authors": authors,
        "publisher": (data.get("publishers", [{}])[0].get("name") if data.get("publishers") else None),
        "year": data.get("publish_date", "")[:4] if data.get("publish_date") else None,
        "page_count": data.get("number_of_pages"),
        "cover_url": data.get("cover", {}).get("medium") if data.get("cover") else None,
        "description": data.get("notes", "") or data.get("description", ""),
    }


def _parse_ol_search(doc: dict) -> dict:
    isbns = doc.get("isbn", [])
    isbn = isbns[0] if isbns else None
    cover_i = doc.get("cover_i")
    cover = f"{_COVERS}/id/{cover_i}-M.jpg" if cover_i else None
    return {
        "title": doc.get("title", ""),
        "isbn": isbn,
        "olid": (doc.get("key", "") or "").replace("/works/", ""),
        "authors": [{"name": a, "olid": ""} for a in doc.get("author_name", [])],
        "year": doc.get("first_publish_year"),
        "cover_url": cover,
        "publisher": None,
        "page_count": None,
        "description": None,
    }
