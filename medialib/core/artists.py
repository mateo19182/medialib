from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class ParsedArtist:
    name: str
    role: str  # "main" or "featured"


_FEAT_PATTERNS = [
    re.compile(r"\s+feat\.?\s+", re.IGNORECASE),
    re.compile(r"\s+ft\.?\s+", re.IGNORECASE),
    re.compile(r"\s+featuring\s+", re.IGNORECASE),
    re.compile(r"\s+with\s+", re.IGNORECASE),
    re.compile(r"\(feat\.?\s+", re.IGNORECASE),
    re.compile(r"\[feat\.?\s+", re.IGNORECASE),
    re.compile(r"\(ft\.?\s+", re.IGNORECASE),
]

_PAREN_FEAT = re.compile(r"\s*[\(\[]feat\.?\s+.+?[\)\]]", re.IGNORECASE)

_MAIN_SEPARATORS = [
    re.compile(r"\s*,\s+"),
    re.compile(r"\s+&\s+"),
    re.compile(r"\s+and\s+", re.IGNORECASE),
    re.compile(r"\s+x\s+", re.IGNORECASE),
    re.compile(r"\s+vs\.?\s+", re.IGNORECASE),
    re.compile(r"\s+/\s+"),
]


def _normalize_part(name: str) -> str:
    return name.strip().strip("()[]").strip()


def split_artists(raw: str) -> list[ParsedArtist]:
    """Split a compound artist string into individual artists with roles.

    Examples:
        "03 Greedo, Kenny Beats, Freddie Gibbs" -> all main
        "Drake feat. Future" -> Drake main, Future featured
        "A & B" -> both main
        "Artist (feat. X)" -> Artist main, X featured
    """
    raw = (raw or "").strip()
    if not raw:
        return [ParsedArtist(name="Unknown", role="main")]

    featured: list[str] = []

    # First, extract parenthesized "(feat. X)" / "[feat. X]" blocks
    for m in _PAREN_FEAT.finditer(raw):
        inner = m.group().strip("()[] ")
        inner = re.sub(r"^(feat\.?|ft\.?)\s*", "", inner, flags=re.IGNORECASE).strip()
        if inner:
            for part in re.split(r"\s*,\s+|\s+&\s+", inner):
                name = _normalize_part(part)
                if name:
                    featured.append(name)
    remaining = _PAREN_FEAT.sub("", raw).strip()

    # Then, extract inline feat./ft./featuring/with patterns (non-parenthesized)
    for pat in _FEAT_PATTERNS:
        m = pat.search(remaining)
        if m:
            before = remaining[: m.start()]
            after = remaining[m.end() :]
            after = after.strip().rstrip(")")
            if after:
                for part in re.split(r"\s*,\s+|\s+&\s+", after):
                    name = _normalize_part(part)
                    if name:
                        featured.append(name)
            remaining = before.strip().rstrip("(").strip()

    # Now split the remaining (main artists) on main separators
    main_names: list[str] = [remaining]
    for pat in _MAIN_SEPARATORS:
        new_names: list[str] = []
        for name in main_names:
            parts = pat.split(name)
            new_names.extend(parts)
        main_names = new_names

    result: list[ParsedArtist] = []
    for name in main_names:
        name = _normalize_part(name)
        if name:
            result.append(ParsedArtist(name=name, role="main"))
    for name in featured:
        name = _normalize_part(name)
        if name:
            result.append(ParsedArtist(name=name, role="featured"))

    if not result:
        result.append(ParsedArtist(name=raw, role="main"))

    return result


def primary_artist(raw: str) -> str:
    """Return just the first (primary) artist from a compound string."""
    artists = split_artists(raw)
    return artists[0].name if artists else raw
