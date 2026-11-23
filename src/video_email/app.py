"""Video email: the web server.

Three kinds of address:
  /app, /api/...       the program staff use (sign-in required)
  /v/, /g/, /e/, /m/    what recipients touch: watch page, email preview, tracking
  /r/                   "record a video for us" pages for guests, cleaners, owners
"""
from __future__ import annotations

import hashlib
import hmac
import io
import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import alerts, auth, config, pages
from .store import Store

log = logging.getLogger("video_email")
STATIC = Path(__file__).parent / "static"
SESSION_COOKIE = "ss_session"
VIEWER_COOKIE = "ss_viewer"
MAX_CHUNK = 20 * 1024 * 1024
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
EXT_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
             "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime", "mkv": "video/x-matroska"}
OPEN_DEDUPE_SECONDS = 30 * 60

# Mail scanners and link checkers that load images or links without a person.
BOT_UA = re.compile(
    r"bot|crawl|spider|preview|scanner|barracuda|proofpoint|mimecast|symantec|"
    r"messagelabs|forcepoint|trendmicro|cisco|ironport|python|curl|wget|headless|"
    r"facebookexternalhit|slackbot|twitterbot|linkedinbot|whatsapp|skypeuripreview",
    re.I,
)


def create_app(store: Store | None = None) -> FastAPI:
    store = store or Store()
    s = store.settings
    app = FastAPI(title=f"{s.company} Video", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    brand_name = config.safe_name(s.company)

    def branded(name: str, media_type: str, headers: dict | None = None) -> Response:
        """A page or script from the static folder with the company name filled in."""
        text = (STATIC / name).read_text(encoding="utf-8").replace("__COMPANY__", brand_name)
        return Response(text, media_type=media_type, headers=headers or {"Cache-Control": "no-cache"})

    BRANDED_TYPES = {".js": "text/javascript", ".html": "text/html; charset=utf-8",
                     ".webmanifest": "application/manifest+json"}

    class BrandedStatic(StaticFiles):
        async def get_response(self, path, scope):
            kind = BRANDED_TYPES.get(Path(path).suffix)
            if kind and "/" not in path and "\\" not in path and (STATIC / path).is_file():
                return branded(path, kind, {"Cache-Control": "public, max-age=3600"})
            return await super().get_response(path, scope)

    app.mount("/static", BrandedStatic(directory=STATIC), name="static")
    secure_cookies = s.public_url.startswith("https://")

    # ------------------------------------------------------------ helpers

    def conn():
        return store.conn

    def now() -> float:
        return time.time()

    def client_ip(request: Request) -> str:
        return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "")

    def session_token(request: Request) -> str:
        # Normally the sign-in cookie. Some phone browsers throw cookies away,
        # so the program also sends the same key in a header.
        return request.cookies.get(SESSION_COOKIE) or request.headers.get("x-session", "")

    def current_user(request: Request):
        tok = session_token(request)
        if tok:
            return conn().execute(
                "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1", (tok,)
            ).fetchone()
        # Pictures and videos inside the program are plain links (no header
        # possible): they carry a separate key that only works for viewing.
        mk = request.query_params.get("mk", "")
        if mk and request.method == "GET" and request.url.path.startswith("/api/videos/"):
            return conn().execute(
                "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.media_key=? AND u.active=1", (mk,)
            ).fetchone()
        return None

    def require_user(request: Request):
        user = current_user(request)
        if not user:
            raise HTTPException(401, "Please sign in")
        return user

    def require_admin(request: Request):
        user = require_user(request)
        if user["role"] != "admin":
            raise HTTPException(403, "Admins only")
        return user

    def signed_in(request: Request, user_id: int) -> JSONResponse:
        """Start a session; answer with the cookie AND the key in the body (for cookie-less phones)."""
        tok, mk = auth.token(), auth.token(16)
        conn().execute("INSERT INTO sessions(token, user_id, media_key, user_agent, created_at) VALUES (?,?,?,?,?)",
                       (tok, user_id, mk, request.headers.get("user-agent", "")[:300], now()))
        response = JSONResponse({"ok": True, "session": tok, "media_key": mk})
        # SameSite=None so the sender's own browser is recognised when the
        # email preview loads inside Gmail -- that is how we avoid counting
        # the sender looking at their own email as an "open".
        response.set_cookie(
            SESSION_COOKIE, tok, max_age=365 * 86400, httponly=True,
            samesite="none" if secure_cookies else "lax", secure=secure_cookies,
        )
        return response

    def get_video(video_id: str, user=None):
        v = conn().execute("SELECT * FROM videos WHERE id=?", (video_id,)).fetchone()
        if not v:
            raise HTTPException(404, "Video not found")
        if user is not None and user["role"] != "admin" and v["owner_id"] != user["id"]:
            raise HTTPException(404, "Video not found")
        return v

    def get_share(tok: str):
        sh = conn().execute(
            "SELECT sh.*, v.owner_id, v.title, v.status FROM shares sh JOIN videos v ON v.id=sh.video_id WHERE sh.token=?",
            (tok,),
        ).fetchone()
        if not sh:
            raise HTTPException(404, "Not found")
        return sh

    def video_path(video_id: str, kind: str) -> Path:
        ext = {"video": "bin", "thumb": "jpg", "gif": "gif", "orig": "bin", "edit": "bin"}[kind]
        return s.video_dir / f"{video_id}.{kind}.{ext}"

    def who(sh) -> str:
        return sh["recipient_name"] or sh["recipient_email"] or sh["recipient_phone"] or "Someone"

    def share_url(tok: str) -> str:
        return f"{s.public_url}/v/{tok}"

    def video_link(video_id: str) -> str:
        return f"{s.public_url}/app#/video/{video_id}"

    def unlock_sig(video_id: str) -> str:
        return hmac.new(store.secret().encode(), f"unlock:{video_id}".encode(), hashlib.sha256).hexdigest()[:32]

    def is_unlocked(request: Request, v) -> bool:
        if not v["password_hash"]:
            return True
        return hmac.compare_digest(request.cookies.get(f"unlock_{v['id']}", ""), unlock_sig(v["id"]))

    def parse_skips(raw) -> list[list[float]]:
        """Cut-out sections, cleaned: numbers only, start < end, sorted, merged."""
        try:
            items = json.loads(raw) if isinstance(raw, str) else list(raw or [])
        except (TypeError, ValueError):
            return []
        pairs = []
        for item in items[:500]:
            try:
                a, b = float(item[0]), float(item[1])
            except (TypeError, ValueError, IndexError, KeyError):
                continue  # ignore one bad entry, keep the rest
            if b > a >= 0:
                pairs.append([a, b])
        pairs.sort()
        merged: list[list[float]] = []
        for a, b in pairs:
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([round(a, 2), round(b, 2)])
        return merged

    def needs_manager(v) -> bool:
        owner = conn().execute("SELECT needs_approval FROM users WHERE id=?", (v["owner_id"],)).fetchone()
        return bool(owner and owner["needs_approval"]) and v["approval"] != "approved"

    def not_live_yet(v) -> bool:
        return bool(v["publish_at"]) and v["publish_at"] > now()

    def json_list(raw) -> list:
        try:
            val = json.loads(raw or "[]")
            return val if isinstance(val, list) else []
        except ValueError:
            return []

    def expired(v) -> bool:
        return bool(v["expires_at"]) and v["expires_at"] < now()

    def record_event(sh, kind: str, request: Request, viewer: str = "", percent: int = 0,
                     detail: str = "", likely_bot: bool = False) -> int:
        cur = conn().execute(
            "INSERT INTO events(share_token, video_id, owner_id, kind, viewer_id, percent, detail, ip, ua, likely_bot, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (sh["token"], sh["video_id"], sh["created_by"], kind, viewer, percent, detail[:2000],
             client_ip(request), request.headers.get("user-agent", "")[:300], int(likely_bot), now()),
        )
        return cur.lastrowid

    def share_payload(sh, v) -> dict[str, Any]:
        url = share_url(sh["token"])
        gif = f"{s.public_url}/g/{sh['token']}.gif"
        alt = f"Video: {v['title'] or 'a video for you'} - click to play"
        html = (
            f'<div><a href="{url}" target="_blank" rel="noopener">'
            f'<img src="{gif}" alt="{_esc(alt)}" width="400" style="width:400px;max-width:100%;border-radius:10px;display:block" />'
            f'</a><div style="margin-top:6px;font-size:13px"><a href="{url}" target="_blank" rel="noopener">'
            f"&#9654; Watch the video</a></div></div>"
        )
        return {"token": sh["token"], "url": url, "gif_url": gif, "html": html,
                "recipient_name": sh["recipient_name"], "recipient_email": sh["recipient_email"],
                "recipient_phone": sh["recipient_phone"], "channel": sh["channel"], "created_at": sh["created_at"]}

    def video_dict(v) -> dict[str, Any]:
        d = dict(v)
        d.pop("password_hash", None)
        d["has_password"] = bool(v["password_hash"])
        d["skips"] = parse_skips(v["skips"])
        d["chapters"] = json_list(v["chapters"])
        d["questions"] = json_list(v["questions"])
        d["needs_manager"] = needs_manager(v)
        stats = conn().execute(
            "SELECT SUM(kind='open' AND likely_bot=0) AS opens, SUM(kind='play') AS plays,"
            " COUNT(DISTINCT CASE WHEN kind='play' THEN COALESCE(NULLIF(viewer_id,''), share_token) END) AS viewers"
            " FROM events WHERE video_id=?",
            (v["id"],),
        ).fetchone()
        d["opens"] = stats["opens"] or 0
        d["plays"] = stats["plays"] or 0
        d["viewers"] = stats["viewers"] or 0
        owner = conn().execute("SELECT name FROM users WHERE id=?", (v["owner_id"],)).fetchone()
        d["owner_name"] = owner["name"] if owner else ""
        return d

    # ------------------------------------------------------------ pages

    @app.get("/", include_in_schema=False)
    def root():
        return RedirectResponse("/app")

    @app.get("/app", include_in_schema=False)
    def app_page():
        return branded("app.html", "text/html; charset=utf-8")

    @app.get("/sw.js", include_in_schema=False)
    def service_worker():
        return branded("sw.js", "text/javascript")

    @app.get("/manifest.webmanifest", include_in_schema=False)
    def manifest():
        return branded("manifest.webmanifest", "application/manifest+json")

    @app.post("/share-target", include_in_schema=False)
    def share_target_fallback():
        # Normally the phone app's service worker catches shared videos; if it
        # isn't running yet, just open the program.
        return RedirectResponse("/app#/", status_code=303)

    @app.get("/healthz", include_in_schema=False)
    def healthz():
        return {"ok": True}

    # ------------------------------------------------------------ sign-in

    @app.post("/api/login")
    async def login(request: Request):
        body = await request.json()
        email = str(body.get("email", "")).strip().lower()
        user = conn().execute("SELECT * FROM users WHERE lower(email)=? AND active=1", (email,)).fetchone()
        if not user or not user["password_hash"] or not auth.check_password(str(body.get("password", "")), user["password_hash"]):
            time.sleep(0.5)
            raise HTTPException(401, "Wrong email or password")
        return signed_in(request, user["id"])

    @app.post("/api/logout")
    def logout(request: Request):
        tok = session_token(request)
        if tok:
            conn().execute("DELETE FROM sessions WHERE token=?", (tok,))
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(SESSION_COOKIE)
        return resp

    @app.get("/api/invite/{tok}")
    def invite_info(tok: str):
        user = conn().execute("SELECT name, email FROM users WHERE invite_token=? AND active=1", (tok,)).fetchone()
        if not user:
            raise HTTPException(404, "This link has already been used or is not valid")
        return dict(user)

    @app.post("/api/invite/{tok}")
    async def accept_invite(tok: str, request: Request):
        body = await request.json()
        password = str(body.get("password", ""))
        if len(password) < 8:
            raise HTTPException(400, "Use at least 8 characters")
        user = conn().execute("SELECT * FROM users WHERE invite_token=? AND active=1", (tok,)).fetchone()
        if not user:
            raise HTTPException(404, "This link has already been used or is not valid")
        conn().execute("UPDATE users SET password_hash=?, invite_token=NULL WHERE id=?",
                       (auth.hash_password(password), user["id"]))
        return signed_in(request, user["id"])

    @app.get("/api/me")
    def me(request: Request):
        user = require_user(request)
        d = {k: user[k] for k in ("id", "email", "name", "phone", "role", "alert_email", "alert_push", "alert_text",
                                  "alert_opens", "needs_approval")}
        d["email_alerts_ready"] = s.email_ready
        sess = conn().execute("SELECT media_key FROM sessions WHERE token=?", (session_token(request),)).fetchone()
        mk = sess["media_key"] if sess else None
        if sess and not mk:  # sessions from before this existed
            mk = auth.token(16)
            conn().execute("UPDATE sessions SET media_key=? WHERE token=?", (mk, session_token(request)))
        d["media_key"] = mk or ""
        d["has_signature"] = signature_path(user["id"]).exists()
        d["texting_ready"] = s.texting_ready
        d["push_key"] = alerts.vapid_keys(conn())[1]
        d["push_devices"] = conn().execute("SELECT COUNT(*) FROM push_subs WHERE user_id=?", (user["id"],)).fetchone()[0]
        return d

    @app.patch("/api/me")
    async def update_me(request: Request):
        user = require_user(request)
        body = await request.json()
        fields = {}
        for key in ("alert_email", "alert_push", "alert_text", "alert_opens"):
            if key in body:
                fields[key] = 1 if body[key] else 0
        for key in ("name", "phone"):
            if key in body:
                fields[key] = str(body[key]).strip()[:100]
        if "password" in body:
            if len(str(body["password"])) < 8:
                raise HTTPException(400, "Use at least 8 characters")
            fields["password_hash"] = auth.hash_password(str(body["password"]))
        if fields:
            sets = ", ".join(f"{k}=?" for k in fields)
            conn().execute(f"UPDATE users SET {sets} WHERE id=?", (*fields.values(), user["id"]))
        return {"ok": True}

    # ------------------------------------------------------------ email signature picture (shown under videos)

    def signature_path(user_id: int) -> Path:
        d = s.data_dir / "signatures"
        d.mkdir(exist_ok=True)
        return d / f"{int(user_id)}.png"

    @app.get("/s/{user_id}.png")
    def signature_image(user_id: int):
        path = signature_path(user_id)
        if not path.exists():
            raise HTTPException(404, "No signature")
        return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})

    @app.put("/api/me/signature")
    async def put_signature(request: Request):
        """Upload (or with an empty body, remove) your signature picture."""
        from PIL import Image

        user = require_user(request)
        data = await request.body()
        path = signature_path(user["id"])
        if not data:
            path.unlink(missing_ok=True)
            return {"ok": True}
        if len(data) > 5 * 1024 * 1024:
            raise HTTPException(400, "Use a picture under 5 MB")
        try:
            with Image.open(io.BytesIO(data)) as im:
                im.thumbnail((1600, 600))
                im.save(path, "PNG")
        except Exception:  # noqa: BLE001
            raise HTTPException(400, "That file isn't a picture")
        return {"ok": True, "url": f"/s/{user['id']}.png"}

    @app.post("/api/push/subscribe")
    async def push_subscribe(request: Request):
        user = require_user(request)
        body = await request.json()
        keys = body.get("keys") or {}
        if not body.get("endpoint") or not keys.get("p256dh") or not keys.get("auth"):
            raise HTTPException(400, "Bad subscription")
        conn().execute(
            "INSERT INTO push_subs(user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?)"
            " ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth",
            (user["id"], body["endpoint"], keys["p256dh"], keys["auth"], now()),
        )
        return {"ok": True}

    @app.post("/api/push/test")
    def push_test(request: Request):
        user = require_user(request)
        alerts.notify(store, user["id"], "Test alert", "Alerts are working on this device.", f"{s.public_url}/app")
        return {"ok": True}

    # ------------------------------------------------------------ team (admin)

    @app.get("/api/users")
    def list_users(request: Request):
        require_admin(request)
        rows = conn().execute(
            "SELECT u.id, u.email, u.name, u.role, u.active, u.needs_approval, u.invite_token IS NOT NULL AS pending, u.invite_token,"
            " (SELECT COUNT(*) FROM videos WHERE owner_id=u.id) AS videos,"
            " (SELECT COUNT(*) FROM shares WHERE created_by=u.id) AS sent,"
            " (SELECT COUNT(*) FROM events WHERE owner_id=u.id AND kind='play') AS plays,"
            " (SELECT COUNT(*) FROM events WHERE owner_id=u.id AND kind='open' AND likely_bot=0) AS opens"
            " FROM users u ORDER BY u.role, u.name"
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            tok = d.pop("invite_token")
            d["invite_url"] = f"{s.public_url}/app#/invite/{tok}" if tok else ""
            out.append(d)
        return out

    @app.post("/api/users")
    async def add_user(request: Request):
        require_admin(request)
        body = await request.json()
        email = str(body.get("email", "")).strip().lower()
        name = str(body.get("name", "")).strip()
        role = "admin" if body.get("role") == "admin" else "staff"
        if "@" not in email or not name:
            raise HTTPException(400, "Name and email are required")
        if conn().execute("SELECT 1 FROM users WHERE lower(email)=?", (email,)).fetchone():
            raise HTTPException(400, "That email already has an account")
        tok = auth.token()
        conn().execute(
            "INSERT INTO users(email, name, role, invite_token, created_at) VALUES (?,?,?,?,?)",
            (email, name, role, tok, now()),
        )
        return {"invite_url": f"{s.public_url}/app#/invite/{tok}"}

    @app.patch("/api/users/{user_id}")
    async def edit_user(user_id: int, request: Request):
        admin = require_admin(request)
        body = await request.json()
        if user_id == admin["id"] and ("active" in body or "role" in body):
            raise HTTPException(400, "You cannot remove or demote yourself")
        if "active" in body:
            conn().execute("UPDATE users SET active=? WHERE id=?", (1 if body["active"] else 0, user_id))
            if not body["active"]:
                conn().execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        if body.get("role") in ("admin", "staff"):
            conn().execute("UPDATE users SET role=? WHERE id=?", (body["role"], user_id))
        if "needs_approval" in body:
            conn().execute("UPDATE users SET needs_approval=? WHERE id=?", (1 if body["needs_approval"] else 0, user_id))
        out: dict[str, Any] = {"ok": True}
        if body.get("new_invite"):
            tok = auth.token()
            conn().execute("UPDATE users SET invite_token=? WHERE id=?", (tok, user_id))
            out["invite_url"] = f"{s.public_url}/app#/invite/{tok}"
        return out

    # ------------------------------------------------------------ videos

    @app.post("/api/videos")
    async def new_video(request: Request):
        user = require_user(request)
        body = await request.json()
        vid = auth.short_id()
        mime = str(body.get("mime") or "video/mp4").split(";")[0]
        if not (mime.startswith("video/") or mime in IMAGE_TYPES):
            raise HTTPException(400, "Not a video or picture")
        conn().execute(
            "INSERT INTO videos(id, owner_id, title, folder, mime, kind, source_url, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (vid, user["id"], str(body.get("title", ""))[:200], str(body.get("folder", ""))[:60], mime,
             "image" if mime in IMAGE_TYPES else "video", str(body.get("source_url", ""))[:1000], now()),
        )
        video_path(vid, "video").write_bytes(b"")
        return {"id": vid}

    # ------------------------------------------------------------ screenshot edits
    # The first edit keeps the untouched capture aside, so markup can always be
    # changed or removed later; the edited picture becomes the one people see.

    @app.put("/api/videos/{vid}/edit")
    async def upload_edit(vid: str, seq: int, request: Request):
        user = require_user(request)
        v = get_video(vid, user)
        if v["kind"] != "image":
            raise HTTPException(400, "Only pictures can be edited this way")
        data = await request.body()
        if len(data) > MAX_CHUNK:
            raise HTTPException(413, "Piece too large")
        path = video_path(vid, "edit")
        if seq == 0:
            path.write_bytes(b"")
        with path.open("ab") as f:
            f.write(data)
        return {"ok": True}

    @app.post("/api/videos/{vid}/edit/finish")
    async def finish_edit(vid: str, request: Request):
        user = require_user(request)
        v = get_video(vid, user)
        body = await request.json()
        edited = video_path(vid, "edit")
        if not edited.exists() or not edited.stat().st_size:
            raise HTTPException(400, "Nothing uploaded")
        mime = str(body.get("mime") or v["mime"])
        if mime not in IMAGE_TYPES:
            raise HTTPException(400, "Not a picture")
        orig = video_path(vid, "orig")
        if not orig.exists():
            video_path(vid, "video").replace(orig)
        edited.replace(video_path(vid, "video"))
        conn().execute("UPDATE videos SET mime=?, size=?, edit_json=?, orig_mime=COALESCE(NULLIF(orig_mime,''), ?) WHERE id=?",
                       (mime, video_path(vid, "video").stat().st_size, str(body.get("edit_json", ""))[:2_000_000],
                        v["mime"], vid))
        return video_dict(get_video(vid))

    @app.get("/api/videos/{vid}/original")
    def original_file(vid: str, request: Request):
        user = require_user(request)
        v = get_video(vid, user)
        orig = video_path(vid, "orig")
        if orig.exists():
            return FileResponse(orig, media_type=v["orig_mime"] or v["mime"])
        return FileResponse(video_path(vid, "video"), media_type=v["mime"])

    # ------------------------------------------------------------ ShareX (desktop captures)

    def user_by_upload_token(request: Request):
        auth_header = request.headers.get("authorization", "")
        tok = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else ""
        if not tok:
            raise HTTPException(401, "Missing upload key")
        user = conn().execute("SELECT * FROM users WHERE upload_token=? AND active=1", (tok,)).fetchone()
        if not user:
            raise HTTPException(401, "Upload key not valid - download a new ShareX setup file")
        return user

    @app.post("/api/sharex/upload")
    async def sharex_upload(request: Request):
        """ShareX sends each capture here; it lands in the library with a share link."""
        user = user_by_upload_token(request)
        form = await request.form()
        up = form.get("file")
        if up is None or not hasattr(up, "read"):
            raise HTTPException(400, "No file")
        name = (getattr(up, "filename", "") or "Desktop capture").rsplit(".", 1)[0][:200]
        mime = (getattr(up, "content_type", "") or "").split(";")[0]
        ext = (getattr(up, "filename", "") or "").rsplit(".", 1)[-1].lower()
        mime = mime if (mime in IMAGE_TYPES or mime.startswith("video/")) else EXT_TYPES.get(ext, "")
        if not mime:
            raise HTTPException(400, "Only pictures and videos can be uploaded")
        vid = auth.short_id()
        conn().execute(
            "INSERT INTO videos(id, owner_id, title, folder, mime, kind, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (vid, user["id"], name, "Screenshots", mime, "image" if mime in IMAGE_TYPES else "video", "ready", now()),
        )
        path = video_path(vid, "video")
        with path.open("wb") as f:
            while chunk := await up.read(1024 * 1024):
                f.write(chunk)
        conn().execute("UPDATE videos SET size=? WHERE id=?", (path.stat().st_size, vid))
        if mime in IMAGE_TYPES:
            make_thumbnail(vid, path)
        else:
            threading.Thread(target=post_process, args=(vid,), daemon=True).start()
        sh = make_share(user, get_video(vid), {"channel": "link"})
        return {"url": share_url(sh["token"]), "page": video_link(vid), "thumbnail": f"{s.public_url}/t/{sh['token']}.jpg"}

    def make_thumbnail(vid: str, src: Path) -> None:
        try:
            from PIL import Image

            with Image.open(src) as im:
                im = im.convert("RGB")
                w = min(1280, im.width)
                h = max(1, round(im.height * w / im.width))
                # Very tall captures: thumbnail the top part, like a page preview.
                im = im.resize((w, h)).crop((0, 0, w, min(h, round(w * 0.75))))
                im.save(video_path(vid, "thumb"), "JPEG", quality=85)
            conn().execute("UPDATE videos SET has_thumb=1 WHERE id=?", (vid,))
        except Exception:  # noqa: BLE001 -- a missing preview picture is not worth failing the upload
            log.exception("thumbnail failed for %s", vid)

    @app.get("/api/sharex/config")
    def sharex_config(request: Request, reset: int = 0):
        user = require_user(request)
        tok = user["upload_token"]
        if not tok or reset:
            tok = auth.token(24)
            conn().execute("UPDATE users SET upload_token=? WHERE id=?", (tok, user["id"]))
        cfg = {
            "Version": "16.0.0",
            "Name": f"{s.company} ({user['name']})",
            "DestinationType": "ImageUploader, FileUploader",
            "RequestMethod": "POST",
            "RequestURL": f"{s.public_url}/api/sharex/upload",
            "Headers": {"Authorization": f"Bearer {tok}"},
            "Body": "MultipartFormData",
            "FileFormName": "file",
            "URL": "{json:url}",
            "ThumbnailURL": "{json:thumbnail}",
        }
        return Response(json.dumps(cfg, indent=2), media_type="application/octet-stream",
                        headers={"Content-Disposition": f'attachment; filename="{config.slug(s.company)}-video.sxcu"'})

    def append_chunk(vid: str, seq: int, data: bytes) -> None:
        if len(data) > MAX_CHUNK:
            raise HTTPException(413, "Chunk too large")
        path = video_path(vid, "video")
        marker = s.video_dir / f"{vid}.seq"
        expected = int(marker.read_text()) if marker.exists() else 0
        if seq < expected:
            return  # a retry of a piece we already have
        if seq != expected:
            raise HTTPException(409, f"Expected piece {expected}")
        with path.open("ab") as f:
            f.write(data)
        marker.write_text(str(seq + 1))

    @app.put("/api/videos/{vid}/chunk")
    async def upload_chunk(vid: str, seq: int, request: Request):
        user = require_user(request)
        v = get_video(vid, user)
        if v["status"] != "recording":
            raise HTTPException(409, "Video already finished")
        append_chunk(vid, seq, await request.body())
        return {"ok": True}

    def finish(vid: str, body: dict) -> None:
        path = video_path(vid, "video")
        (s.video_dir / f"{vid}.seq").unlink(missing_ok=True)
        transcript = str(body.get("transcript", ""))[:50000]
        title = str(body.get("title", "")).strip()[:200]
        if not title:
            words = transcript.split()
            title = " ".join(words[:7]).strip(" ,.") if words else ""
        conn().execute(
            "UPDATE videos SET status='ready', size=?, duration=?, transcript=?, captions=?,"
            " title=CASE WHEN title='' THEN ? ELSE title END WHERE id=?",
            (path.stat().st_size, float(body.get("duration") or 0), transcript,
             str(body.get("captions", ""))[:100000], title or "Untitled video", vid),
        )
        cleanup_storage()
        threading.Thread(target=post_process, args=(vid,), daemon=True).start()

    def post_process(vid: str) -> None:
        """After an upload: re-pack the video so it starts instantly in every
        browser, and make the email preview here if the browser didn't."""
        from . import media

        try:
            v = get_video(vid)
            if v["kind"] != "video":
                return
            path = video_path(vid, "video")
            duration = media.remux_to_faststart(path)
            if duration:
                conn().execute("UPDATE videos SET size=?, duration=CASE WHEN duration>0 THEN duration ELSE ? END WHERE id=?",
                               (path.stat().st_size, duration, vid))
            # The recorder usually sends its own preview within seconds; give it time first.
            time.sleep(90)
            v = conn().execute("SELECT has_gif, has_thumb, trim_start FROM videos WHERE id=?", (vid,)).fetchone()
            if v and not v["has_gif"]:
                thumb = None if v["has_thumb"] else video_path(vid, "thumb")
                if media.make_email_preview(path, video_path(vid, "gif"), thumb, start=v["trim_start"] or 0):
                    conn().execute("UPDATE videos SET has_gif=1, has_thumb=CASE WHEN ? THEN 1 ELSE has_thumb END WHERE id=?",
                                   (thumb is not None and thumb.exists(), vid))
        except HTTPException:
            pass  # deleted meanwhile
        except Exception:  # noqa: BLE001
            log.exception("post-processing %s failed", vid)

    @app.post("/api/videos/{vid}/finish")
    async def finish_video(vid: str, request: Request):
        user = require_user(request)
        get_video(vid, user)
        finish(vid, await request.json())
        return video_dict(get_video(vid))

    @app.put("/api/videos/{vid}/thumb")
    async def put_thumb(vid: str, request: Request):
        user = require_user(request)
        get_video(vid, user)
        data = await request.body()
        if not data.startswith(b"\xff\xd8") or len(data) > 5 * 1024 * 1024:
            raise HTTPException(400, "Thumbnail must be a JPEG under 5 MB")
        video_path(vid, "thumb").write_bytes(data)
        conn().execute("UPDATE videos SET has_thumb=1 WHERE id=?", (vid,))
        return {"ok": True}

    @app.put("/api/videos/{vid}/gif")
    async def put_gif(vid: str, request: Request):
        user = require_user(request)
        get_video(vid, user)
        data = await request.body()
        if not data.startswith(b"GIF8") or len(data) > 8 * 1024 * 1024:
            raise HTTPException(400, "Preview must be a GIF under 8 MB")
        video_path(vid, "gif").write_bytes(data)
        conn().execute("UPDATE videos SET has_gif=1 WHERE id=?", (vid,))
        return {"ok": True}

    @app.get("/api/videos")
    def list_videos(request: Request, q: str = "", folder: str = "", mine: int = 0, kind: str = ""):
        user = require_user(request)
        sql = "SELECT * FROM videos WHERE status='ready'"
        args: list[Any] = []
        if kind in ("video", "image"):
            sql += " AND kind=?"
            args.append(kind)
        if user["role"] != "admin" or mine:
            sql += " AND owner_id=?"
            args.append(user["id"])
        if folder:
            sql += " AND folder=?"
            args.append(folder)
        if q:
            sql += " AND (title LIKE ? OR transcript LIKE ?)"
            args += [f"%{q}%", f"%{q}%"]
        sql += " ORDER BY created_at DESC LIMIT 300"
        return [video_dict(v) for v in conn().execute(sql, args).fetchall()]

    @app.get("/api/folders")
    def list_folders(request: Request):
        user = require_user(request)
        sql = "SELECT DISTINCT folder FROM videos WHERE folder<>''"
        args: list[Any] = []
        if user["role"] != "admin":
            sql += " AND owner_id=?"
            args.append(user["id"])
        names = {r["folder"] for r in conn().execute(sql, args)}
        return sorted((names | {"Guests", "Owners", "Prospects", "Clients"}) - {"Received", "Testimonials"})

    @app.get("/api/videos/{vid}")
    def video_detail(vid: str, request: Request):
        user = require_user(request)
        v = get_video(vid, user)
        d = video_dict(v)
        shares = conn().execute("SELECT * FROM shares WHERE video_id=? ORDER BY created_at DESC", (vid,)).fetchall()
        d["shares"] = []
        for sh in shares:
            p = share_payload(sh, v)
            agg = conn().execute(
                "SELECT SUM(kind='open' AND likely_bot=0) AS opens, SUM(kind='play') AS plays,"
                " MAX(CASE WHEN kind='play' THEN percent END) AS best, MAX(created_at) AS last"
                " FROM events WHERE share_token=?", (sh["token"],),
            ).fetchone()
            p.update(opens=agg["opens"] or 0, plays=agg["plays"] or 0, best_percent=agg["best"] or 0, last=agg["last"])
            d["shares"].append(p)
        d["events"] = [dict(e) for e in conn().execute(
            "SELECT e.id, e.kind, e.percent, e.detail, e.likely_bot, e.created_at, e.share_token,"
            " sh.recipient_name, sh.recipient_email, sh.recipient_phone"
            " FROM events e LEFT JOIN shares sh ON sh.token=e.share_token"
            " WHERE e.video_id=? ORDER BY e.created_at DESC LIMIT 500", (vid,),
        )]
        # Rewatch map: how many play sessions covered each 5% slice.
        counts = [0] * 20
        for row in conn().execute(
            "SELECT vw.buckets FROM views vw JOIN events e ON e.id=vw.event_id WHERE e.video_id=?", (vid,)
        ):
            for i, ch in enumerate(row["buckets"][:20]):
                counts[i] += int(ch) if ch.isdigit() else 0
        d["rewatch"] = counts
        d["totals"] = video_totals(vid)
        # Answers to the video's questions, per question.
        answers: dict[str, list] = {}
        for e in conn().execute(
            "SELECT e.detail, e.created_at, sh.recipient_name, sh.recipient_email, sh.recipient_phone FROM events e"
            " LEFT JOIN shares sh ON sh.token=e.share_token WHERE e.video_id=? AND e.kind='answer' ORDER BY e.created_at DESC",
            (vid,),
        ):
            try:
                a = json.loads(e["detail"])
            except ValueError:
                continue
            answers.setdefault(a.get("id", ""), []).append(
                {"a": a.get("a"), "who": e["recipient_name"] or e["recipient_email"] or e["recipient_phone"] or "Someone",
                 "at": e["created_at"]})
        d["answers"] = answers
        return d

    @app.patch("/api/videos/{vid}")
    async def edit_video(vid: str, request: Request):
        user = require_user(request)
        v = get_video(vid, user)
        body = await request.json()
        fields: dict[str, Any] = {}
        for key in ("title", "folder", "cta_label", "cta_url", "confirm_label", "reveal_text"):
            if key in body:
                fields[key] = str(body[key]).strip()[:1000]
        for key in ("approve_buttons", "view_once", "consent", "show_transcript"):
            if key in body:
                fields[key] = 1 if body[key] else 0
        if "skips" in body:
            fields["skips"] = json.dumps(parse_skips(body["skips"]))
        if "captions" in body:
            fields["captions"] = str(body["captions"])[:200000]
        if "chapters" in body:
            chapters = []
            for c in (body["chapters"] or [])[:100]:
                try:
                    chapters.append({"t": max(0.0, round(float(c["t"]), 1)), "title": str(c["title"]).strip()[:120]})
                except (KeyError, TypeError, ValueError):
                    continue
            fields["chapters"] = json.dumps(sorted((c for c in chapters if c["title"]), key=lambda c: c["t"]))
        if "questions" in body:
            qs = []
            for q in (body["questions"] or [])[:20]:
                try:
                    kind = q["type"] if q["type"] in ("rating", "choice", "text") else "choice"
                    item = {"id": str(q.get("id") or auth.short_id(6))[:12], "type": kind,
                            "q": str(q["q"]).strip()[:300],
                            "t": None if q.get("t") in (None, "") else max(0.0, float(q["t"])),
                            "options": [str(o).strip()[:100] for o in (q.get("options") or []) if str(o).strip()][:8]}
                except (KeyError, TypeError, ValueError):
                    continue
                if item["q"] and (kind != "choice" or len(item["options"]) >= 2):
                    qs.append(item)
            fields["questions"] = json.dumps(qs)
        if "publish_at" in body:
            fields["publish_at"] = float(body["publish_at"]) if body["publish_at"] else None
        if "transcript" in body:  # for screenshots: the words read out of the picture, so search finds them
            fields["transcript"] = str(body["transcript"])[:100000]
        if fields.get("cta_url") and not re.match(r"^(https?://|mailto:|tel:)", fields["cta_url"]):
            fields["cta_url"] = "https://" + fields["cta_url"]
        for key in ("trim_start", "trim_end"):
            if key in body:
                fields[key] = max(0.0, float(body[key] or 0))
        if "password" in body:
            fields["password_hash"] = auth.hash_password(body["password"]) if body["password"] else ""
        if "expires_at" in body:
            fields["expires_at"] = float(body["expires_at"]) if body["expires_at"] else None
        if fields:
            sets = ", ".join(f"{k}=?" for k in fields)
            conn().execute(f"UPDATE videos SET {sets} WHERE id=?", (*fields.values(), v["id"]))
        return video_dict(get_video(vid))

    @app.delete("/api/videos/{vid}")
    def delete_video(vid: str, request: Request):
        user = require_user(request)
        get_video(vid, user)
        remove_video(vid)
        return {"ok": True}

    def remove_video(vid: str) -> None:
        for kind in ("video", "thumb", "gif", "orig", "edit"):
            video_path(vid, kind).unlink(missing_ok=True)
        (s.video_dir / f"{vid}.seq").unlink(missing_ok=True)
        c = conn()
        c.execute("DELETE FROM kv WHERE key=?", (f"upload:{vid}",))
        c.execute("DELETE FROM views WHERE event_id IN (SELECT id FROM events WHERE video_id=?)", (vid,))
        c.execute("DELETE FROM events WHERE video_id=?", (vid,))
        c.execute("DELETE FROM playlist_items WHERE video_id=?", (vid,))
        c.execute("DELETE FROM shares WHERE video_id=?", (vid,))
        c.execute("DELETE FROM videos WHERE id=?", (vid,))

    @app.get("/api/videos/{vid}/file")
    def owner_file(vid: str, request: Request):
        user = require_user(request)
        v = get_video(vid, user)
        return FileResponse(video_path(vid, "video"), media_type=v["mime"])

    @app.post("/api/videos/{vid}/shares")
    async def create_share(vid: str, request: Request):
        user = require_user(request)
        v = get_video(vid, user)
        body = await request.json()
        return share_payload(make_share(user, v, body), v)

    def make_share(user, v, body: dict):
        if needs_manager(v):
            raise HTTPException(409, "This video is waiting for a manager to approve it before it can be sent")
        channel = body.get("channel") if body.get("channel") in ("email", "text", "link", "qr", "sms") else "link"
        tok = auth.short_id(12)
        name = str(body.get("recipient_name", "")).strip()[:100]
        email = str(body.get("recipient_email", "")).strip().lower()[:200]
        phone = re.sub(r"[^\d+]", "", str(body.get("recipient_phone", "")))[:20]
        conn().execute(
            "INSERT INTO shares(token, video_id, created_by, recipient_name, recipient_email, recipient_phone, channel, created_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (tok, v["id"], user["id"], name, email, phone, channel, now()),
        )
        return conn().execute("SELECT * FROM shares WHERE token=?", (tok,)).fetchone()

    @app.patch("/api/shares/{tok}")
    async def name_share(tok: str, request: Request):
        """Label who a link went to, after sending it."""
        user = require_user(request)
        sh = get_share(tok)
        get_video(sh["video_id"], user)
        body = await request.json()
        conn().execute("UPDATE shares SET recipient_name=? WHERE token=?", (str(body.get("recipient_name", "")).strip()[:100], tok))
        return {"ok": True}

    @app.post("/api/videos/{vid}/sms")
    async def send_sms(vid: str, request: Request):
        """Text the video from the business number (Version 2)."""
        user = require_user(request)
        v = get_video(vid, user)
        if not s.texting_ready:
            raise HTTPException(409, "Texting from the business number isn't switched on yet")
        body = await request.json()
        if not alerts.normalize_phone(str(body.get("recipient_phone", ""))):
            raise HTTPException(400, "Add a mobile number")
        sh = make_share(user, v, {**body, "channel": "sms"})
        first = (sh["recipient_name"] or "").split(" ")[0]
        text = str(body.get("message") or "").strip() or (
            f"{'Hi ' + first + ', ' if first else ''}{user['name']} from {s.company} sent you a quick video:")
        try:
            msg_id = alerts.send_text(s, sh["recipient_phone"], f"{text} {share_url(sh['token'])}")
        except Exception as exc:  # noqa: BLE001
            conn().execute("UPDATE shares SET sms_status='failed' WHERE token=?", (sh["token"],))
            raise HTTPException(502, f"The text didn't go through: {exc}")
        conn().execute("UPDATE shares SET sms_status=? WHERE token=?", (f"sent:{msg_id}", sh["token"]))
        return share_payload(sh, v)

    @app.post("/api/videos/{vid}/submit")
    def submit_for_approval(vid: str, request: Request):
        user = require_user(request)
        v = get_video(vid, user)
        conn().execute("UPDATE videos SET approval='pending' WHERE id=?", (vid,))
        alerts.notify_admins(store, f"{user['name']} needs a video approved", f"\"{v['title']}\"", video_link(vid))
        return {"ok": True}

    @app.post("/api/videos/{vid}/approve")
    async def approve_video(vid: str, request: Request):
        admin = require_admin(request)
        v = get_video(vid)
        body = await request.json()
        ok = bool(body.get("approve", True))
        conn().execute("UPDATE videos SET approval=? WHERE id=?", ("approved" if ok else "", vid))
        note = str(body.get("note", "")).strip()[:500]
        alerts.notify(store, v["owner_id"],
                      f"Your video was {'approved' if ok else 'sent back'} by {admin['name']}",
                      f"\"{v['title']}\"" + (f" - {note}" if note else ""), video_link(vid))
        return {"ok": True}

    @app.get("/api/videos/{vid}/qr.png")
    def video_qr(vid: str, request: Request):
        import segno

        user = require_user(request)
        v = get_video(vid, user)
        if needs_manager(v):
            raise HTTPException(409, "This video is waiting for a manager to approve it")
        sh = conn().execute(
            "SELECT * FROM shares WHERE video_id=? AND channel='qr' ORDER BY created_at LIMIT 1", (vid,)
        ).fetchone()
        if not sh:
            tok = auth.short_id(12)
            conn().execute(
                "INSERT INTO shares(token, video_id, created_by, recipient_name, channel, created_at) VALUES (?,?,?,?,?,?)",
                (tok, vid, v["owner_id"], "QR code scan", "qr", now()),
            )
            sh = conn().execute("SELECT * FROM shares WHERE token=?", (tok,)).fetchone()
        buf = io.BytesIO()
        segno.make(share_url(sh["token"]), error="m").save(buf, kind="png", scale=12, border=2)
        return Response(buf.getvalue(), media_type="image/png",
                        headers={"Content-Disposition": f'inline; filename="qr-{vid}.png"'})

    @app.get("/api/contacts")
    def contacts(request: Request, q: str = ""):
        user = require_user(request)
        like = f"%{q.strip()}%"
        rows = conn().execute(
            "SELECT recipient_name AS name, recipient_email AS email, recipient_phone AS phone, MAX(created_at) AS last"
            " FROM shares WHERE created_by=? AND (recipient_email<>'' OR recipient_phone<>'')"
            " AND (recipient_name LIKE ? OR recipient_email LIKE ? OR recipient_phone LIKE ?)"
            " GROUP BY lower(recipient_name), recipient_email, recipient_phone ORDER BY last DESC LIMIT 15",
            (user["id"], like, like, like),
        ).fetchall()
        return [dict(r) for r in rows]

    @app.get("/api/activity")
    def activity(request: Request, limit: int = 100, user_id: int = 0, before: float = 0):
        user = require_user(request)
        sql = (
            "SELECT e.id, e.kind, e.percent, e.detail, e.likely_bot, e.created_at, e.video_id, e.share_token,"
            " v.title, sh.recipient_name, sh.recipient_email, sh.recipient_phone, u.name AS owner_name"
            " FROM events e JOIN videos v ON v.id=e.video_id LEFT JOIN shares sh ON sh.token=e.share_token"
            " JOIN users u ON u.id=e.owner_id WHERE 1=1"
        )
        args: list[Any] = []
        if user["role"] != "admin":
            sql += " AND e.owner_id=?"
            args.append(user["id"])
        elif user_id:
            sql += " AND e.owner_id=?"
            args.append(user_id)
        if before:
            sql += " AND e.created_at<?"
            args.append(before)
        sql += " ORDER BY e.created_at DESC LIMIT ?"
        args.append(min(limit, 500))
        return [dict(r) for r in conn().execute(sql, args)]

    # ------------------------------------------------------------ "record a video for us"

    @app.post("/api/requests")
    async def new_request(request: Request):
        user = require_user(request)
        body = await request.json()
        title = str(body.get("title", "")).strip()[:200] or "Please record a short video for us"
        tok = auth.short_id(12)
        conn().execute(
            "INSERT INTO requests(token, owner_id, title, message, testimonial, created_at) VALUES (?,?,?,?,?,?)",
            (tok, user["id"], title, str(body.get("message", "")).strip()[:2000], 1 if body.get("testimonial") else 0, now()),
        )
        return {"token": tok, "url": f"{s.public_url}/r/{tok}"}

    @app.get("/api/requests")
    def list_requests(request: Request):
        user = require_user(request)
        sql = "SELECT * FROM requests WHERE active=1"
        args: list[Any] = []
        if user["role"] != "admin":
            sql += " AND owner_id=?"
            args.append(user["id"])
        rows = conn().execute(sql + " ORDER BY created_at DESC", args).fetchall()
        return [dict(r) | {"url": f"{s.public_url}/r/{r['token']}"} for r in rows]

    @app.delete("/api/requests/{tok}")
    def close_request(tok: str, request: Request):
        user = require_user(request)
        r = conn().execute("SELECT * FROM requests WHERE token=?", (tok,)).fetchone()
        if not r or (user["role"] != "admin" and r["owner_id"] != user["id"]):
            raise HTTPException(404, "Not found")
        conn().execute("UPDATE requests SET active=0 WHERE token=?", (tok,))
        return {"ok": True}

    def get_request(tok: str):
        r = conn().execute("SELECT * FROM requests WHERE token=? AND active=1", (tok,)).fetchone()
        if not r:
            raise HTTPException(404, "This link is no longer active")
        return r

    @app.get("/r/{tok}", response_class=HTMLResponse)
    def request_page(tok: str):
        r = conn().execute("SELECT * FROM requests WHERE token=? AND active=1", (tok,)).fetchone()
        if not r:
            return HTMLResponse(pages.message_page(s.company, "This link is no longer active."), status_code=404)
        owner = conn().execute("SELECT name FROM users WHERE id=?", (r["owner_id"],)).fetchone()
        return HTMLResponse(pages.request_page(s.company, dict(r), owner["name"] if owner else s.company))

    @app.post("/r/{tok}/start")
    async def request_start(tok: str, request: Request):
        r = get_request(tok)
        body = await request.json()
        name = str(body.get("name", "")).strip()[:100] or "Someone"
        mime = str(body.get("mime") or "video/mp4").split(";")[0]
        if not mime.startswith("video/"):
            raise HTTPException(400, "Please choose a video")
        vid = auth.short_id()
        upload_key = auth.token(16)
        conn().execute(
            "INSERT INTO videos(id, owner_id, title, folder, mime, received_from, transcript, consent, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (vid, r["owner_id"], f"From {name}: {r['title']}"[:200], "Testimonials" if r["testimonial"] else "Received",
             mime, name, str(body.get("note", "")).strip()[:2000], 1 if (r["testimonial"] and body.get("consent")) else 0, now()),
        )
        conn().execute("INSERT INTO kv(key, value) VALUES (?, ?)", (f"upload:{vid}", upload_key))
        video_path(vid, "video").write_bytes(b"")
        return {"id": vid, "key": upload_key}

    def check_upload_key(vid: str, key: str) -> None:
        row = conn().execute("SELECT value FROM kv WHERE key=?", (f"upload:{vid}",)).fetchone()
        if not row or not hmac.compare_digest(row["value"], key):
            raise HTTPException(403, "Upload not allowed")

    @app.put("/r/{tok}/chunk/{vid}")
    async def request_chunk(tok: str, vid: str, seq: int, key: str, request: Request):
        get_request(tok)
        check_upload_key(vid, key)
        append_chunk(vid, seq, await request.body())
        return {"ok": True}

    @app.post("/r/{tok}/finish/{vid}")
    async def request_finish(tok: str, vid: str, key: str, request: Request):
        r = get_request(tok)
        check_upload_key(vid, key)
        body = await request.json()
        v = get_video(vid)
        finish(vid, {"duration": body.get("duration", 0), "title": v["title"], "transcript": v["transcript"]})
        conn().execute("DELETE FROM kv WHERE key=?", (f"upload:{vid}",))
        conn().execute(
            "INSERT INTO events(video_id, owner_id, kind, detail, ip, ua, created_at) VALUES (?,?,?,?,?,?,?)",
            (vid, r["owner_id"], "received", v["received_from"], client_ip(request),
             request.headers.get("user-agent", "")[:300], now()),
        )
        alerts.notify(store, r["owner_id"], f"New video from {v['received_from']}",
                      f"{v['received_from']} recorded a video for \"{r['title']}\".", video_link(vid))
        return {"ok": True}

    @app.put("/r/{tok}/thumb/{vid}")
    async def request_thumb(tok: str, vid: str, key: str, request: Request):
        get_request(tok)
        check_upload_key(vid, key)
        data = await request.body()
        if data.startswith(b"\xff\xd8") and len(data) < 5 * 1024 * 1024:
            video_path(vid, "thumb").write_bytes(data)
            conn().execute("UPDATE videos SET has_thumb=1 WHERE id=?", (vid,))
        return {"ok": True}

    # ------------------------------------------------------------ what recipients see

    @app.get("/v/{tok}", response_class=HTMLResponse)
    def watch_page(tok: str, request: Request):
        sh = conn().execute("SELECT * FROM shares WHERE token=?", (tok,)).fetchone()
        if not sh:
            return HTMLResponse(pages.message_page(s.company, "This video link is not valid."), status_code=404)
        v = get_video(sh["video_id"])
        owner = dict(conn().execute("SELECT id, name, email, phone FROM users WHERE id=?", (v["owner_id"],)).fetchone())
        sig = signature_path(owner["id"])
        owner["signature"] = f"/s/{owner['id']}.png?v={int(sig.stat().st_mtime)}" if sig.exists() else ""
        if expired(v):
            return HTMLResponse(pages.message_page(s.company, "This video has expired."), status_code=410)
        if needs_manager(v):
            return HTMLResponse(pages.message_page(s.company, "This video isn't available yet."), status_code=403)
        if not_live_yet(v) and not current_user(request):
            from datetime import datetime
            from zoneinfo import ZoneInfo

            when = datetime.fromtimestamp(v["publish_at"], ZoneInfo("America/New_York")).strftime("%A, %B %d").replace(" 0", " ")
            return HTMLResponse(pages.message_page(s.company, f"This video will be ready on {when}. Please check back then."),
                                status_code=403)
        viewer = request.cookies.get(VIEWER_COOKIE) or auth.token(12)
        if v["view_once"] and not current_user(request) and view_once_used(sh["token"], viewer):
            return HTMLResponse(pages.message_page(
                s.company, "This video could only be watched once, and it has already been viewed."), status_code=410)
        vd = dict(v)
        vd["skips"] = parse_skips(v["skips"])
        vd["chapters"] = json_list(v["chapters"])
        vd["questions"] = json_list(v["questions"])
        resp = HTMLResponse(pages.watch_page(
            company=s.company, company_url=s.company_url, public_url=s.public_url, share=dict(sh), video=vd, owner=owner,
            locked=not is_unlocked(request, v), embed=request.query_params.get("embed") == "1",
        ))
        if not request.cookies.get(VIEWER_COOKIE):
            resp.set_cookie(VIEWER_COOKIE, viewer, max_age=2 * 365 * 86400, httponly=True,
                            samesite="lax", secure=secure_cookies)
        return resp

    def view_once_used(tok: str, viewer: str) -> bool:
        """View-once: the first person to press play has 3 hours; then the link closes for everyone."""
        first = conn().execute(
            "SELECT viewer_id, created_at FROM events WHERE share_token=? AND kind='play' ORDER BY id LIMIT 1", (tok,)
        ).fetchone()
        if not first:
            return False
        return first["viewer_id"] != viewer or now() - first["created_at"] > 3 * 3600

    @app.post("/v/{tok}/unlock")
    async def unlock(tok: str, request: Request):
        sh = get_share(tok)
        v = get_video(sh["video_id"])
        body = await request.json()
        if not v["password_hash"] or not auth.check_password(str(body.get("password", "")), v["password_hash"]):
            time.sleep(0.5)
            raise HTTPException(403, "Wrong password")
        resp = JSONResponse({"ok": True})
        resp.set_cookie(f"unlock_{v['id']}", unlock_sig(v["id"]), max_age=30 * 86400, httponly=True,
                        samesite="lax", secure=secure_cookies)
        return resp

    @app.get("/m/{tok}/video")
    def media_video(tok: str, request: Request):
        sh = get_share(tok)
        v = get_video(sh["video_id"])
        if expired(v) or not is_unlocked(request, v) or needs_manager(v) or (not_live_yet(v) and not current_user(request)):
            raise HTTPException(403, "Not available")
        if v["view_once"] and not current_user(request) and view_once_used(tok, request.cookies.get(VIEWER_COOKIE, "")):
            raise HTTPException(410, "Already viewed")
        return FileResponse(video_path(v["id"], "video"), media_type=v["mime"],
                            headers={"Cache-Control": "private, max-age=3600"})

    @app.get("/m/{tok}/captions.vtt")
    def media_captions(tok: str):
        sh = get_share(tok)
        v = get_video(sh["video_id"])
        return Response(v["captions"] or "WEBVTT\n", media_type="text/vtt")

    @app.get("/t/{tok}.jpg")
    def media_thumb(tok: str):
        sh = get_share(tok)
        path = video_path(sh["video_id"], "thumb")
        if not path.exists():
            return FileResponse(STATIC / "poster.jpg", media_type="image/jpeg")
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})

    @app.get("/api/videos/{vid}/thumb.jpg")
    def owner_thumb(vid: str, request: Request):
        user = require_user(request)
        get_video(vid, user)
        path = video_path(vid, "thumb")
        return FileResponse(path if path.exists() else STATIC / "poster.jpg", media_type="image/jpeg")

    @app.get("/g/{tok}.gif")
    def email_preview(tok: str, request: Request):
        """The moving preview in the email. Loading it is how we see an open."""
        sh = conn().execute("SELECT * FROM shares WHERE token=?", (tok,)).fetchone()
        if not sh:
            return FileResponse(STATIC / "poster.gif", media_type="image/gif")
        user = current_user(request)
        if not user:  # the sender's own browser (e.g. while composing) is never an open
            ua = request.headers.get("user-agent", "")
            likely_bot = bool(BOT_UA.search(ua)) and "GoogleImageProxy" not in ua
            recent = conn().execute(
                "SELECT 1 FROM events WHERE share_token=? AND kind='open' AND likely_bot=0 AND created_at>?",
                (tok, now() - OPEN_DEDUPE_SECONDS),
            ).fetchone()
            # Gmail loads the pictures of an email itself the moment it is sent (for
            # the sender's own copy). That first load through Google's image server
            # is the send, not the recipient opening it.
            detail = ""
            if "GoogleImageProxy" in ua and sh["channel"] == "email" and not conn().execute(
                "SELECT 1 FROM events WHERE share_token=? AND kind='open' AND ua LIKE '%GoogleImageProxy%'", (tok,)
            ).fetchone():
                likely_bot, detail = True, "sent"
            record_event(sh, "open", request, likely_bot=likely_bot, detail=detail)
            v = conn().execute("SELECT title, kind FROM videos WHERE id=?", (sh["video_id"],)).fetchone()
            owner = conn().execute("SELECT alert_opens FROM users WHERE id=?", (sh["created_by"],)).fetchone()
            if not likely_bot and not recent and owner and owner["alert_opens"]:
                nxt = "if they press play" if v["kind"] == "video" else "when they open the full picture"
                alerts.notify(store, sh["created_by"], f"{who(sh)} opened your email",
                              f"\"{v['title']}\" - email opened (likely). You'll get another alert {nxt}.",
                              video_link(sh["video_id"]))
        no_cache = {"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"}
        v = conn().execute("SELECT kind, mime FROM videos WHERE id=?", (sh["video_id"],)).fetchone()
        if v and v["kind"] == "image":
            # Screenshots: a GIF shows itself; any other picture shows its preview.
            if v["mime"] == "image/gif":
                return FileResponse(video_path(sh["video_id"], "video"), media_type="image/gif", headers=no_cache)
            thumb = video_path(sh["video_id"], "thumb")
            return FileResponse(thumb if thumb.exists() else STATIC / "poster.jpg", media_type="image/jpeg", headers=no_cache)
        path = video_path(sh["video_id"], "gif")
        if not path.exists():
            path = STATIC / "poster.gif"
        return FileResponse(path, media_type="image/gif", headers=no_cache)

    @app.post("/e/{tok}")
    async def track(tok: str, request: Request):
        """Events from the watch page: play, progress, click, like, comment."""
        sh = get_share(tok)
        try:
            body = json.loads(await request.body() or b"{}")
        except ValueError:
            raise HTTPException(400, "Bad event")
        kind = body.get("kind")
        if current_user(request):  # the sender trying their own video: show it, count nothing
            if kind == "confirm":
                return {"ok": True, "self": True, "reveal": get_video(sh["video_id"])["reveal_text"]}
            return {"ok": True, "self": True}
        viewer = request.cookies.get(VIEWER_COOKIE, "")[:40]
        ua = request.headers.get("user-agent", "")
        bot = bool(BOT_UA.search(ua))
        title = sh["title"]
        name = who(sh)
        link = video_link(sh["video_id"])
        if kind == "play":
            if bot:
                return {"ok": True}
            event_id = record_event(sh, "play", request, viewer=viewer)
            conn().execute("INSERT INTO views(event_id, updated_at) VALUES (?,?)", (event_id, now()))
            conn().execute("UPDATE videos SET last_viewed_at=? WHERE id=?", (now(), sh["video_id"]))
            earlier = conn().execute(
                "SELECT COUNT(*) FROM events WHERE share_token=? AND kind='play' AND id<?", (tok, event_id)
            ).fetchone()[0]
            again = f" (view #{earlier + 1})" if earlier else ""
            kind_row = conn().execute("SELECT kind FROM videos WHERE id=?", (sh["video_id"],)).fetchone()
            what = "is watching your video" if kind_row["kind"] == "video" else "is looking at your screenshot"
            alerts.notify(store, sh["created_by"], f"{name} {what}{again}", f"\"{title}\"", link)
            return {"ok": True, "view": event_id}
        if kind == "progress":
            event_id = int(body.get("view") or 0)
            buckets = str(body.get("buckets", ""))[:20]
            if not re.fullmatch(r"[0-9]{20}", buckets):
                raise HTTPException(400, "Bad progress")
            ev = conn().execute("SELECT * FROM events WHERE id=? AND share_token=? AND kind='play'", (event_id, tok)).fetchone()
            if ev:
                percent = 5 * sum(c != "0" for c in buckets)
                conn().execute("UPDATE views SET buckets=?, max_percent=?, updated_at=? WHERE event_id=?",
                               (buckets, percent, now(), event_id))
                conn().execute("UPDATE events SET percent=MAX(percent, ?) WHERE id=?", (percent, event_id))
            return {"ok": True}
        if kind == "confirm":
            v = get_video(sh["video_id"])
            if not v["confirm_label"] or not is_unlocked(request, v):
                raise HTTPException(400, "Nothing to confirm")
            if not bot:
                record_event(sh, "confirm", request, viewer=viewer, detail=v["confirm_label"])
                alerts.notify(store, sh["created_by"], f"{name} confirmed: {v['confirm_label']}", f"\"{title}\"", link)
            # The hidden text (e.g. a door code) is only ever sent after they confirm.
            return {"ok": True, "reveal": v["reveal_text"]}
        if kind == "answer":
            v = get_video(sh["video_id"])
            q = next((q for q in json_list(v["questions"]) if q.get("id") == body.get("id")), None)
            if not q:
                raise HTTPException(400, "Unknown question")
            ans = body.get("a")
            if q["type"] == "rating":
                ans = max(1, min(5, int(ans or 0)))
            elif q["type"] == "choice":
                if ans not in q["options"]:
                    raise HTTPException(400, "Pick one of the answers")
            else:
                ans = str(ans or "").strip()[:1000]
                if not ans:
                    raise HTTPException(400, "Empty answer")
            record_event(sh, "answer", request, viewer=viewer, detail=json.dumps({"id": q["id"], "q": q["q"], "a": ans}))
            shown = ("★" * ans + f" ({ans}/5)") if q["type"] == "rating" else str(ans)
            alerts.notify(store, sh["created_by"], f"{name} answered: {q['q'][:60]}", shown, link)
            return {"ok": True}
        if kind in ("approve", "decline"):
            v = get_video(sh["video_id"])
            if not v["approve_buttons"]:
                raise HTTPException(400, "Not an approval video")
            text = str(body.get("text", "")).strip()[:2000]
            record_event(sh, kind, request, viewer=viewer, detail=text)
            word = "APPROVED" if kind == "approve" else "DECLINED"
            alerts.notify(store, sh["created_by"], f"{name} {word}", f"\"{title}\"" + (f" - {text}" if text else ""), link)
            return {"ok": True}
        if kind in ("click", "like", "comment"):
            if bot:
                return {"ok": True}
            text = str(body.get("text", "")).strip()[:2000]
            if kind == "comment" and not text:
                raise HTTPException(400, "Empty reply")
            record_event(sh, kind, request, viewer=viewer, detail=text)
            if kind == "click":
                alerts.notify(store, sh["created_by"], f"{name} clicked your button", f"\"{text}\" on \"{title}\"", link)
            elif kind == "like":
                alerts.notify(store, sh["created_by"], f"{name} liked your video", f"\"{title}\"", link)
            else:
                alerts.notify(store, sh["created_by"], f"{name} replied to your video", text, link)
            return {"ok": True}
        raise HTTPException(400, "Unknown event")

    # ------------------------------------------------------------ replace a video, keep its links

    @app.post("/api/videos/{vid}/replace-with/{new_id}")
    def replace_with(vid: str, new_id: str, request: Request):
        """Swap in a new take: every link already sent shows the new video."""
        user = require_user(request)
        old, new = get_video(vid, user), get_video(new_id, user)
        if new["status"] != "ready" or old["kind"] != new["kind"]:
            raise HTTPException(400, "Pick a finished video of the same type")
        for kind in ("video", "thumb", "gif"):
            src = video_path(new_id, kind)
            if src.exists():
                src.replace(video_path(vid, kind))
        for kind in ("orig", "edit"):
            video_path(vid, kind).unlink(missing_ok=True)
        conn().execute(
            "UPDATE videos SET mime=?, size=?, duration=?, has_thumb=?, has_gif=?, transcript=?, captions=?,"
            " trim_start=0, trim_end=0, skips='[]', chapters='[]', edit_json='', orig_mime='' WHERE id=?",
            (new["mime"], new["size"], new["duration"], new["has_thumb"], new["has_gif"], new["transcript"],
             new["captions"], vid),
        )
        conn().execute("DELETE FROM videos WHERE id=?", (new_id,))
        (s.video_dir / f"{new_id}.seq").unlink(missing_ok=True)
        return video_dict(get_video(vid))

    # ------------------------------------------------------------ playlists (one page per property)

    def get_playlist(pid: str, user=None):
        p = conn().execute("SELECT * FROM playlists WHERE id=?", (pid,)).fetchone()
        if not p or (user is not None and user["role"] != "admin" and p["owner_id"] != user["id"]):
            raise HTTPException(404, "Playlist not found")
        return p

    def playlist_dict(p) -> dict[str, Any]:
        items = conn().execute(
            "SELECT v.id, v.title, v.kind, v.mime, v.duration, pi.share_token, pi.position FROM playlist_items pi"
            " JOIN videos v ON v.id=pi.video_id WHERE pi.playlist_id=? ORDER BY pi.position, v.created_at", (p["id"],),
        ).fetchall()
        views = conn().execute(
            "SELECT COUNT(*) FROM events WHERE kind='play' AND share_token IN"
            " (SELECT share_token FROM playlist_items WHERE playlist_id=?)", (p["id"],),
        ).fetchone()[0]
        return dict(p) | {"url": f"{s.public_url}/p/{p['id']}", "items": [dict(i) for i in items], "views": views}

    @app.get("/api/playlists")
    def list_playlists(request: Request):
        user = require_user(request)
        sql, args = "SELECT * FROM playlists", []
        if user["role"] != "admin":
            sql += " WHERE owner_id=?"
            args.append(user["id"])
        return [playlist_dict(p) for p in conn().execute(sql + " ORDER BY created_at DESC", args).fetchall()]

    @app.post("/api/playlists")
    async def new_playlist(request: Request):
        user = require_user(request)
        body = await request.json()
        title = str(body.get("title", "")).strip()[:150]
        if not title:
            raise HTTPException(400, "Give the playlist a name")
        pid = auth.short_id(10)
        conn().execute("INSERT INTO playlists(id, owner_id, title, description, created_at) VALUES (?,?,?,?,?)",
                       (pid, user["id"], title, str(body.get("description", "")).strip()[:1000], now()))
        return playlist_dict(get_playlist(pid))

    @app.patch("/api/playlists/{pid}")
    async def edit_playlist(pid: str, request: Request):
        user = require_user(request)
        p = get_playlist(pid, user)
        body = await request.json()
        if "title" in body or "description" in body:
            conn().execute("UPDATE playlists SET title=?, description=? WHERE id=?",
                           (str(body.get("title", p["title"])).strip()[:150] or p["title"],
                            str(body.get("description", p["description"])).strip()[:1000], pid))
        if "videos" in body:  # the full list, in order
            wanted = [str(x) for x in body["videos"]][:100]
            have = {r["video_id"]: r["share_token"] for r in
                    conn().execute("SELECT * FROM playlist_items WHERE playlist_id=?", (pid,))}
            conn().execute("DELETE FROM playlist_items WHERE playlist_id=?", (pid,))
            for pos, vid in enumerate(wanted):
                v = get_video(vid, user)
                if needs_manager(v):
                    raise HTTPException(409, f"\"{v['title']}\" is waiting for manager approval")
                tok = have.get(vid)
                if not tok:
                    tok = make_share(user, v, {"channel": "link", "recipient_name": f"Playlist: {p['title']}"[:100]})["token"]
                conn().execute("INSERT INTO playlist_items(playlist_id, video_id, position, share_token) VALUES (?,?,?,?)",
                               (pid, vid, pos, tok))
        return playlist_dict(get_playlist(pid))

    @app.delete("/api/playlists/{pid}")
    def delete_playlist(pid: str, request: Request):
        user = require_user(request)
        get_playlist(pid, user)
        conn().execute("DELETE FROM playlist_items WHERE playlist_id=?", (pid,))
        conn().execute("DELETE FROM playlists WHERE id=?", (pid,))
        return {"ok": True}

    @app.get("/api/playlists/{pid}/qr.png")
    def playlist_qr(pid: str, request: Request):
        import segno

        user = require_user(request)
        get_playlist(pid, user)
        buf = io.BytesIO()
        segno.make(f"{s.public_url}/p/{pid}", error="m").save(buf, kind="png", scale=12, border=2)
        return Response(buf.getvalue(), media_type="image/png")

    @app.get("/p/{pid}", response_class=HTMLResponse)
    def playlist_page(pid: str):
        p = conn().execute("SELECT * FROM playlists WHERE id=?", (pid,)).fetchone()
        if not p:
            return HTMLResponse(pages.message_page(s.company, "This page is not available."), status_code=404)
        d = playlist_dict(p)
        live = [i for i in d["items"] if not not_live_yet(get_video(i["id"])) and not expired(get_video(i["id"]))]
        owner = conn().execute("SELECT name, email, phone FROM users WHERE id=?", (p["owner_id"],)).fetchone()
        return HTMLResponse(pages.playlist_page(s.company, d, live, dict(owner)))

    # ------------------------------------------------------------ reports: totals across everyone

    def device_of(ua: str) -> str:
        u = ua.lower()
        if "ipad" in u or "tablet" in u:
            return "Tablet"
        if "mobi" in u or "iphone" in u or "android" in u:
            return "Phone"
        return "Computer" if ua else "Unknown"

    def video_totals(vid: str) -> dict[str, Any]:
        plays = conn().execute(
            "SELECT e.viewer_id, e.share_token, e.ua, e.percent, vw.buckets FROM events e"
            " LEFT JOIN views vw ON vw.event_id=e.id WHERE e.video_id=? AND e.kind='play'", (vid,),
        ).fetchall()
        n = len(plays)
        unique = len({p["viewer_id"] or p["share_token"] for p in plays})
        reached = [0] * 20  # how many views got at least this far
        for p in plays:
            b = p["buckets"] or ""
            last = max((i for i, c in enumerate(b[:20]) if c != "0"), default=-1)
            for i in range(last + 1):
                reached[i] += 1
        devices: dict[str, int] = {}
        for p in plays:
            devices[device_of(p["ua"])] = devices.get(device_of(p["ua"]), 0) + 1
        return {"views": n, "unique": unique,
                "avg_percent": round(sum(p["percent"] for p in plays) / n) if n else 0,
                "still_watching": [round(100 * r / n) if n else 0 for r in reached], "devices": devices}

    @app.get("/api/reports")
    def reports(request: Request, days: int = 30, user_id: int = 0):
        user = require_user(request)
        since = now() - max(1, min(days, 365)) * 86400
        scope, args = "", []
        if user["role"] != "admin":
            scope, args = " AND e.owner_id=?", [user["id"]]
        elif user_id:
            scope, args = " AND e.owner_id=?", [user_id]
        rows = conn().execute(
            "SELECT e.kind, e.created_at, e.video_id, e.owner_id, e.percent, e.ua, e.likely_bot, e.viewer_id, e.share_token"
            " FROM events e WHERE e.created_at>=?" + scope, [since, *args],
        ).fetchall()
        from datetime import datetime
        from zoneinfo import ZoneInfo

        tz = ZoneInfo("America/New_York")
        per_day: dict[str, dict[str, int]] = {}
        per_video: dict[str, dict[str, Any]] = {}
        devices: dict[str, int] = {}
        viewers = set()
        for r in rows:
            day = datetime.fromtimestamp(r["created_at"], tz).strftime("%Y-%m-%d")
            dd = per_day.setdefault(day, {"opens": 0, "views": 0})
            pv = per_video.setdefault(r["video_id"], {"views": 0, "opens": 0, "pct": []})
            if r["kind"] == "open" and not r["likely_bot"]:
                dd["opens"] += 1
                pv["opens"] += 1
            elif r["kind"] == "play":
                dd["views"] += 1
                pv["views"] += 1
                pv["pct"].append(r["percent"])
                devices[device_of(r["ua"])] = devices.get(device_of(r["ua"]), 0) + 1
                viewers.add(r["viewer_id"] or r["share_token"])
        top = []
        for vid, pv in sorted(per_video.items(), key=lambda kv: -kv[1]["views"])[:15]:
            v = conn().execute("SELECT v.title, v.kind, u.name FROM videos v JOIN users u ON u.id=v.owner_id WHERE v.id=?", (vid,)).fetchone()
            if v:
                top.append({"id": vid, "title": v["title"], "owner": v["name"], "views": pv["views"], "opens": pv["opens"],
                            "avg_percent": round(sum(pv["pct"]) / len(pv["pct"])) if pv["pct"] else 0})
        days_list = []
        for i in range(max(1, min(days, 365)) - 1, -1, -1):
            day = datetime.fromtimestamp(now() - i * 86400, tz).strftime("%Y-%m-%d")
            days_list.append({"day": day, **per_day.get(day, {"opens": 0, "views": 0})})
        return {"days": days_list, "top": top, "devices": devices, "unique_viewers": len(viewers),
                "views": sum(d["views"] for d in days_list), "opens": sum(d["opens"] for d in days_list),
                "sent": conn().execute("SELECT COUNT(*) FROM shares sh WHERE sh.created_at>=?" +
                                       scope.replace("e.owner_id", "sh.created_by"), [since, *args]).fetchone()[0]}

    # ------------------------------------------------------------ storage cap

    def cleanup_storage() -> None:
        """Stay inside the free storage: clear the oldest videos nobody has
        watched in 6 months, only when the cap is reached."""
        total = sum(p.stat().st_size for p in s.video_dir.glob("*") if p.is_file())
        if total <= s.storage_limit:
            return
        cutoff = now() - 180 * 86400
        stale = conn().execute(
            "SELECT id, size FROM videos WHERE status='ready' AND created_at<? AND COALESCE(last_viewed_at, 0)<?"
            " ORDER BY COALESCE(last_viewed_at, created_at)", (cutoff, cutoff),
        ).fetchall()
        for v in stale:
            if total <= s.storage_limit:
                break
            log.info("storage cap: removing unwatched video %s", v["id"])
            remove_video(v["id"])
            total -= v["size"]

    def abandoned_cleanup() -> None:
        while True:
            time.sleep(3600)
            try:
                old = conn().execute(
                    "SELECT id FROM videos WHERE status='recording' AND created_at<?", (now() - 86400,)
                ).fetchall()
                for v in old:
                    remove_video(v["id"])
                cleanup_storage()
            except Exception:  # noqa: BLE001
                log.exception("cleanup failed")

    threading.Thread(target=abandoned_cleanup, daemon=True).start()
    return app


def _esc(text: str) -> str:
    import html

    return html.escape(text, quote=True)


def create_admin(email: str, name: str) -> str:
    """Make (or re-invite) the first admin. Returns the one-time set-password link."""
    store = Store()
    c = store.conn
    tok = auth.token()
    row = c.execute("SELECT id FROM users WHERE lower(email)=?", (email.lower(),)).fetchone()
    if row:
        c.execute("UPDATE users SET role='admin', active=1, invite_token=? WHERE id=?", (tok, row["id"]))
    else:
        c.execute("INSERT INTO users(email, name, role, invite_token, created_at) VALUES (?,?,?,?,?)",
                  (email.lower(), name, "admin", tok, time.time()))
    return f"{store.settings.public_url}/app#/invite/{tok}"


if __name__ == "__main__":
    import sys

    if len(sys.argv) >= 4 and sys.argv[1] == "create-admin":
        print(create_admin(sys.argv[2], " ".join(sys.argv[3:])))
    else:
        print("usage: python -m video_email.app create-admin EMAIL NAME")
