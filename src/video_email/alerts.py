"""Tell the sender that something happened: email, browser/phone push, text.

Email and push are free. Text alerts go out from the business number and
only once the carrier registration is approved (TEXTING_ENABLED=1).
"""
from __future__ import annotations

import base64
import json
import logging
import smtplib
import sqlite3
import threading
from email.message import EmailMessage

from .config import Settings

log = logging.getLogger("video_email.alerts")


# ---------------------------------------------------------------- web push keys

def vapid_keys(conn: sqlite3.Connection) -> tuple[str, str]:
    """(private PEM, public key for the browser). Made once, kept forever."""
    row = conn.execute("SELECT value FROM kv WHERE key='vapid'").fetchone()
    if row:
        data = json.loads(row["value"])
        return data["private_pem"], data["public"]
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid01

    v = Vapid01()
    v.generate_keys()
    private_pem = v.private_pem().decode()
    raw = v.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    public = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    conn.execute(
        "INSERT OR REPLACE INTO kv(key, value) VALUES ('vapid', ?)",
        (json.dumps({"private_pem": private_pem, "public": public}),),
    )
    return private_pem, public


# ---------------------------------------------------------------- sending

def _send_email(settings: Settings, to: str, subject: str, body: str, link: str) -> None:
    msg = EmailMessage()
    msg["From"] = f"{settings.company} Video <{settings.smtp_user}>"
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(f"{body}\n\n{link}\n")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as s:
        s.login(settings.smtp_user, settings.smtp_password)
        s.send_message(msg)


def normalize_phone(raw: str) -> str:
    """US numbers to +1XXXXXXXXXX; anything already in +country form is kept."""
    digits = "".join(c for c in raw if c.isdigit())
    if raw.strip().startswith("+"):
        return "+" + digits
    if len(digits) == 10:
        return "+1" + digits
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    return ""


def send_text(settings: Settings, to: str, text: str) -> str:
    """Send one text from the business number through Telnyx. Returns its id."""
    import urllib.request

    number = normalize_phone(to)
    if not number:
        raise ValueError("That doesn't look like a mobile number")
    req = urllib.request.Request(
        "https://api.telnyx.com/v2/messages",
        data=json.dumps({"from": settings.text_from, "to": number, "text": text}).encode(),
        headers={"Authorization": f"Bearer {settings.telnyx_api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read()).get("data", {}).get("id", "")


def _send_push(conn: sqlite3.Connection, settings: Settings, user_id: int, title: str, body: str, link: str) -> None:
    from py_vapid import Vapid01
    from pywebpush import WebPushException, webpush

    private_pem, _ = vapid_keys(conn)
    vapid = Vapid01.from_pem(private_pem.encode())
    subs = conn.execute("SELECT * FROM push_subs WHERE user_id=?", (user_id,)).fetchall()
    payload = json.dumps({"title": title, "body": body, "url": link})
    for sub in subs:
        info = {"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}}
        try:
            webpush(info, payload, vapid_private_key=vapid, vapid_claims={"sub": settings.vapid_contact}, ttl=86400)
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None)
            if status in (404, 410):  # that browser unsubscribed or was reset
                conn.execute("DELETE FROM push_subs WHERE id=?", (sub["id"],))
            else:
                log.warning("push to %s failed: %s", sub["id"], exc)


def notify_admins(store, title: str, body: str, link: str) -> None:
    for row in store.conn.execute("SELECT id FROM users WHERE role='admin' AND active=1").fetchall():
        notify(store, row["id"], title, body, link)


def notify(store, user_id: int, title: str, body: str, link: str) -> None:
    """Fire-and-forget: alerts must never slow down the viewer's page."""
    settings = store.settings

    def run() -> None:
        conn = store.conn  # this thread's own connection
        user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if not user or not user["active"]:
            return
        if user["alert_push"]:
            try:
                _send_push(conn, settings, user_id, title, body, link)
            except Exception:  # noqa: BLE001 -- one channel failing must not stop the others
                log.exception("push alert failed")
        if user["alert_email"] and settings.email_ready:
            try:
                _send_email(settings, user["email"], title, body, link)
            except Exception:  # noqa: BLE001
                log.exception("email alert failed")
        if user["alert_text"] and user["phone"] and settings.texting_ready:
            try:
                send_text(settings, user["phone"], f"{title}: {body}\n{link}"[:600])
            except Exception:  # noqa: BLE001
                log.exception("text alert failed")

    threading.Thread(target=run, daemon=True).start()
