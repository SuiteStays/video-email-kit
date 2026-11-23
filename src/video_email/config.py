"""Settings, read once from the environment (and an optional .env file)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    public_url: str
    company: str
    # Where the signature picture under a video links to. Empty = no link.
    company_url: str
    # Gmail SMTP for email alerts. Empty = email alerts switched off.
    smtp_user: str
    smtp_password: str
    # Web push (browser and phone alerts). Generated on first start if missing.
    vapid_contact: str
    # Storage cap before old unwatched videos are cleaned up, in bytes.
    storage_limit: int
    # Texting from the business number (Version 2). Off until the carrier
    # registration is approved; texts sent before that are silently dropped.
    telnyx_api_key: str
    text_from: str
    texting_enabled: bool

    @property
    def texting_ready(self) -> bool:
        return self.texting_enabled and bool(self.telnyx_api_key and self.text_from)

    @property
    def video_dir(self) -> Path:
        return self.data_dir / "videos"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "video_email.db"

    @property
    def email_ready(self) -> bool:
        return bool(self.smtp_user and self.smtp_password)


def safe_name(name: str) -> str:
    """The company name made safe to drop into the pages and scripts as plain text."""
    for ch in ('"', chr(92), '`', '<', '>', '$'):
        name = name.replace(ch, "")
    return name.replace("'", "’").strip() or "My Company"


def slug(name: str) -> str:
    out = "".join(c.lower() if c.isalnum() else "-" for c in name)
    return "-".join(p for p in out.split("-") if p) or "video"


def load() -> Settings:
    root = Path(os.environ.get("VIDEO_EMAIL_HOME", Path.cwd()))
    _load_dotenv(root / ".env")
    data_dir = Path(os.environ.get("VIDEO_EMAIL_DATA", root / "data"))
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "videos").mkdir(exist_ok=True)
    return Settings(
        data_dir=data_dir,
        public_url=os.environ.get("PUBLIC_URL", "http://127.0.0.1:8772").rstrip("/"),
        company=os.environ.get("COMPANY_NAME", "My Company"),
        company_url=os.environ.get("COMPANY_URL", "").strip(),
        smtp_user=os.environ.get("SMTP_USER", ""),
        smtp_password=os.environ.get("SMTP_PASSWORD", ""),
        vapid_contact=os.environ.get("VAPID_CONTACT") or "mailto:" + (os.environ.get("SMTP_USER") or "admin@example.com"),
        storage_limit=int(float(os.environ.get("STORAGE_LIMIT_GB", "12")) * 1024**3),
        telnyx_api_key=os.environ.get("TELNYX_API_KEY", ""),
        text_from=os.environ.get("TEXT_FROM", ""),
        texting_enabled=os.environ.get("TEXTING_ENABLED", "0") == "1",
    )
