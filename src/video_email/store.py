"""Shared state: settings plus one SQLite connection per thread."""
from __future__ import annotations

import sqlite3
import threading

from . import config, db


class Store:
    def __init__(self, settings: config.Settings | None = None) -> None:
        self.settings = settings or config.load()
        self._local = threading.local()
        db.connect(self.settings.db_path).close()  # create tables once

    @property
    def conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "conn", None)
        if c is None:
            c = db.connect(self.settings.db_path)
            self._local.conn = c
        return c

    def secret(self) -> str:
        from .auth import token

        row = self.conn.execute("SELECT value FROM kv WHERE key='secret'").fetchone()
        if row:
            return row["value"]
        value = token(32)
        self.conn.execute("INSERT OR IGNORE INTO kv(key, value) VALUES ('secret', ?)", (value,))
        return self.conn.execute("SELECT value FROM kv WHERE key='secret'").fetchone()["value"]
