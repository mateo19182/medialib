from __future__ import annotations

import re
from dataclasses import dataclass

from rapidfuzz import fuzz

# Patterns to strip from titles for normalization.
_FEAT_RE = re.compile(r"\s*[\(\[].*?(?:feat|ft|featuring)\.?\s.*?[\)\]]", re.IGNORECASE)
_REMASTER_RE = re.compile(
    r"\s*[\(\[]?(?:remaster(?:ed)?|remix|live|bonus track|deluxe|"
    r"mono|stereo|single version|album version|official (?:audio|video|music video)).*?[\)\]]",
    re.IGNORECASE,
)
_NON_ALNUM = re.compile(r"[^a-z0-9 ]+")
_MULTISPACE = re.compile(r"\s+")


def normalize_title(title: str) -> str:
    s = _FEAT_RE.sub(" ", title or "")
    s = _REMASTER_RE.sub(" ", s)
    s = s.lower()
    s = _NON_ALNUM.sub(" ", s)
    return _MULTISPACE.sub(" ", s).strip()


def normalize_artist(name: str) -> str:
    s = (name or "").lower()
    # drop " & ", " x ", " feat " -> keep first artist only? Keep full string but normalized.
    s = _NON_ALNUM.sub(" ", s)
    return _MULTISPACE.sub(" ", s).strip()


@dataclass
class TrackKey:
    title: str
    artist: str
    duration_ms: int | None = None
    isrc: str | None = None

    @property
    def norm_title(self) -> str:
        return normalize_title(self.title)

    @property
    def norm_artist(self) -> str:
        return normalize_artist(self.artist)


def isrc_match(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    return a.strip().upper() == b.strip().upper()


def duration_close(a: int | None, b: int | None, tolerance_ms: int = 3000) -> bool:
    if a is None or b is None:
        return True  # unknown duration -> don't penalize
    return abs(a - b) <= tolerance_ms


def fuzzy_score(a: TrackKey, b: TrackKey) -> int:
    """0-100 similarity. ISRC hard-matches to 100; else weighted fuzzy."""
    if isrc_match(a.isrc, b.isrc):
        return 100
    title = int(fuzz.token_set_ratio(a.norm_title, b.norm_title))
    artist = int(fuzz.token_set_ratio(a.norm_artist, b.norm_artist))
    score = int(0.6 * title + 0.4 * artist)
    if not duration_close(a.duration_ms, b.duration_ms):
        score = max(0, score - 10)
    return score


MATCH_THRESHOLD = 88


def is_match(a: TrackKey, b: TrackKey, threshold: int = MATCH_THRESHOLD) -> bool:
    return fuzzy_score(a, b) >= threshold
