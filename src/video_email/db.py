"""SQLite storage. One file, no server, nothing to pay for."""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    password_hash TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'staff',          -- admin | staff
    alert_email INTEGER NOT NULL DEFAULT 1,
    alert_push INTEGER NOT NULL DEFAULT 1,
    alert_text INTEGER NOT NULL DEFAULT 0,       -- Version 2 (needs texting registration)
    alert_opens INTEGER NOT NULL DEFAULT 1,      -- also alert on email opens, not only plays
    invite_token TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'recording',    -- recording | ready
    mime TEXT NOT NULL DEFAULT 'video/mp4',
    size INTEGER NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,
    trim_start REAL NOT NULL DEFAULT 0,
    trim_end REAL NOT NULL DEFAULT 0,            -- 0 = play to the end
    has_thumb INTEGER NOT NULL DEFAULT 0,
    has_gif INTEGER NOT NULL DEFAULT 0,
    transcript TEXT NOT NULL DEFAULT '',
    captions TEXT NOT NULL DEFAULT '',           -- WebVTT
    cta_label TEXT NOT NULL DEFAULT '',
    cta_url TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL DEFAULT '',
    expires_at REAL,
    received_from TEXT NOT NULL DEFAULT '',      -- set when a recipient recorded it for us
    created_at REAL NOT NULL,
    last_viewed_at REAL
);
CREATE TABLE IF NOT EXISTS shares (
    token TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    created_by INTEGER NOT NULL REFERENCES users(id),
    recipient_name TEXT NOT NULL DEFAULT '',
    recipient_email TEXT NOT NULL DEFAULT '',
    recipient_phone TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'link',        -- email | text | link | qr
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    share_token TEXT,
    video_id TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    kind TEXT NOT NULL,                          -- open | play | click | comment | like | received
    viewer_id TEXT NOT NULL DEFAULT '',
    percent INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    ua TEXT NOT NULL DEFAULT '',
    likely_bot INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS events_owner ON events(owner_id, created_at);
CREATE INDEX IF NOT EXISTS events_video ON events(video_id, created_at);
CREATE TABLE IF NOT EXISTS views (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id),
    buckets TEXT NOT NULL DEFAULT '00000000000000000000',  -- 20 slices of 5%
    max_percent INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
    token TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,                         -- also the public link: /p/<id>
    owner_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
    playlist_id TEXT NOT NULL REFERENCES playlists(id),
    video_id TEXT NOT NULL REFERENCES videos(id),
    position INTEGER NOT NULL DEFAULT 0,
    share_token TEXT NOT NULL,                   -- views from the playlist page are tracked on this link
    PRIMARY KEY (playlist_id, video_id)
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


# Columns added after the first release. Added in place, so existing videos keep working.
MIGRATIONS = {
    "videos": {
        "skips": "TEXT NOT NULL DEFAULT '[]'",            # [[start, end], ...] cut out of playback
        "confirm_label": "TEXT NOT NULL DEFAULT ''",       # "I've watched and agree" button
        "reveal_text": "TEXT NOT NULL DEFAULT ''",         # shown only after they confirm (e.g. door code)
        "approve_buttons": "INTEGER NOT NULL DEFAULT 0",   # Approve / Decline buttons for owners
        "view_once": "INTEGER NOT NULL DEFAULT 0",         # each link plays for one person only
        "approval": "TEXT NOT NULL DEFAULT ''",            # '' | pending | approved (manager check)
        "consent": "INTEGER NOT NULL DEFAULT 0",           # recorder agreed we may use it publicly
        "captions_lang": "TEXT NOT NULL DEFAULT 'en'",
        "kind": "TEXT NOT NULL DEFAULT 'video'",           # video | image (screenshots and GIFs)
        "source_url": "TEXT NOT NULL DEFAULT ''",          # the web page a screenshot was taken of
        "edit_json": "TEXT NOT NULL DEFAULT ''",           # editor markup, so edits stay changeable
        "orig_mime": "TEXT NOT NULL DEFAULT ''",
        "chapters": "TEXT NOT NULL DEFAULT '[]'",          # [{"t": seconds, "title": "..."}]
        "questions": "TEXT NOT NULL DEFAULT '[]'",         # quiz / poll / rating questions
        "publish_at": "REAL",                              # not watchable before this time
        "show_transcript": "INTEGER NOT NULL DEFAULT 0",   # "read along" text on the watch page (off unless switched on)
    },
    "users": {
        "needs_approval": "INTEGER NOT NULL DEFAULT 0",
        "upload_token": "TEXT",                            # ShareX uploads (desktop captures)
    },
    "requests": {
        "testimonial": "INTEGER NOT NULL DEFAULT 0",
    },
    "shares": {
        "sms_status": "TEXT NOT NULL DEFAULT ''",
    },
    "sessions": {
        "media_key": "TEXT",   # lets pictures/videos load for phones whose browser drops cookies
        "user_agent": "TEXT NOT NULL DEFAULT ''",
    },
}


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    for table, cols in MIGRATIONS.items():
        have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for col, ddl in cols.items():
            if col not in have:
                try:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
                except sqlite3.OperationalError:
                    pass  # another thread added it first
    return conn


def now() -> float:
    return time.time()
