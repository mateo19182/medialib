from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


@dataclass
class Settings:
    spotipy_client_id: str = field(default_factory=lambda: os.getenv("SPOTIPY_CLIENT_ID", ""))
    spotipy_client_secret: str = field(default_factory=lambda: os.getenv("SPOTIPY_CLIENT_SECRET", ""))
    spotipy_redirect_uri: str = field(
        default_factory=lambda: os.getenv("SPOTIPY_REDIRECT_URI", "http://127.0.0.1:8000/callback/spotify")
    )
    spotify_scopes: str = field(
        default_factory=lambda: os.getenv(
            "SPOTIFY_SCOPES",
            "user-library-read playlist-read-private playlist-read-collaborative",
        )
    )

    ytmusic_headers_path: str = field(default_factory=lambda: os.getenv("YTMUSIC_HEADERS_PATH", "./data/ytmusic_headers.json"))
    bandcamp_cookie: str = field(default_factory=lambda: os.getenv("BANDCAMP_COOKIE", ""))

    app_secret_key: str = field(default_factory=lambda: os.getenv("APP_SECRET_KEY", "dev-insecure-key"))
    database_path: str = field(default_factory=lambda: os.getenv("DATABASE_PATH", "./data/medialib.db"))

    @property
    def database_url(self) -> str:
        path = Path(self.database_path)
        if not path.is_absolute():
            path = ROOT / path
        path.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{path}"

    @property
    def ytmusic_headers_abs(self) -> Path:
        p = Path(self.ytmusic_headers_path)
        return p if p.is_absolute() else ROOT / p


settings = Settings()
