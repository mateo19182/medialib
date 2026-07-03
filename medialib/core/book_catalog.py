from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from medialib.core.db import Book, BookAuthor, BookAuthorLink
from medialib.core.match import normalize_artist, normalize_title


def _get_or_create_book_author(db: Session, name: str) -> BookAuthor:
    norm = normalize_artist(name)
    row = db.execute(select(BookAuthor).where(BookAuthor.normalized_name == norm)).scalar_one_or_none()
    if row is not None:
        return row
    author = BookAuthor(name=name, normalized_name=norm)
    db.add(author)
    db.flush()
    return author


def upsert_book(
    db: Session,
    *,
    title: str,
    authors: list[str],
    isbn: str | None = None,
    publisher: str | None = None,
    year: int | None = None,
    cover_url: str | None = None,
    description: str | None = None,
    page_count: int | None = None,
    olid: str | None = None,
) -> Book:
    norm_title = normalize_title(title)
    isbn_clean = re.sub(r"[^0-9X]", "", (isbn or "").upper()) if isbn else None

    # Try to find existing by ISBN first
    book = None
    if isbn_clean:
        book = db.execute(select(Book).where(Book.isbn == isbn_clean)).scalar_one_or_none()
    if not book:
        book = db.execute(
            select(Book).where(Book.normalized_title == norm_title, Book.isbn.isnot(None) if isbn_clean else Book.isbn.is_(None))
        ).scalar_one_or_none()

    if book is None:
        book = Book(
            title=title,
            normalized_title=norm_title,
            isbn=isbn_clean,
            publisher=publisher,
            year=year,
            cover_url=cover_url,
            description=description,
            page_count=page_count,
            olid=olid,
        )
        db.add(book)
        db.flush()
    else:
        if not book.isbn and isbn_clean:
            book.isbn = isbn_clean
        if not book.publisher and publisher:
            book.publisher = publisher
        if not book.year and year:
            book.year = year
        if not book.cover_url and cover_url:
            book.cover_url = cover_url
        if not book.description and description:
            book.description = description
        if not book.page_count and page_count:
            book.page_count = page_count
        if not book.olid and olid:
            book.olid = olid

    # Ensure author links
    seen: set[int] = set()
    for pos, name in enumerate(authors):
        if not name:
            continue
        author_row = _get_or_create_book_author(db, name)
        if author_row.id in seen:
            continue
        seen.add(author_row.id)
        existing = db.execute(
            select(BookAuthorLink).where(
                BookAuthorLink.book_id == book.id,
                BookAuthorLink.author_id == author_row.id,
            )
        ).scalar_one_or_none()
        if existing is None:
            db.add(BookAuthorLink(book_id=book.id, author_id=author_row.id, position=pos))

    return book
