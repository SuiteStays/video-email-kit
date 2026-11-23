import time

import pytest
from fastapi.testclient import TestClient

from video_email import alerts, app as appmod, auth, config
from video_email.store import Store

GIF = b"GIF89a" + b"\x00" * 20
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 20


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("VIDEO_EMAIL_HOME", str(tmp_path))
    monkeypatch.setenv("PUBLIC_URL", "http://testserver")
    sent = []
    monkeypatch.setattr(alerts, "notify", lambda store, uid, title, body, link: sent.append((uid, title)))
    store = Store(config.load())
    app = appmod.create_app(store)
    c = store.conn
    now = time.time()
    c.execute("INSERT INTO users(email,name,role,password_hash,created_at) VALUES (?,?,?,?,?)",
              ("boss@x.com", "Pat Boss", "admin", auth.hash_password("password1"), now))
    c.execute("INSERT INTO users(email,name,role,password_hash,created_at) VALUES (?,?,?,?,?)",
              ("staff@x.com", "Sam Staff", "staff", auth.hash_password("password2"), now))
    return app, store, sent


def login(app, email, pw):
    cl = TestClient(app)
    r = cl.post("/api/login", json={"email": email, "password": pw})
    assert r.status_code == 200, r.text
    return cl


def make_video(cl, data=b"0123456789" * 1000):
    vid = cl.post("/api/videos", json={"mime": "video/mp4"}).json()["id"]
    half = len(data) // 2
    assert cl.put(f"/api/videos/{vid}/chunk?seq=0", content=data[:half]).status_code == 200
    assert cl.put(f"/api/videos/{vid}/chunk?seq=0", content=data[:half]).status_code == 200  # retry is harmless
    assert cl.put(f"/api/videos/{vid}/chunk?seq=1", content=data[half:]).status_code == 200
    v = cl.post(f"/api/videos/{vid}/finish", json={"duration": 12.5, "transcript": "hello there welcome to the lake house tour today"}).json()
    assert v["size"] == len(data)
    assert v["title"] == "hello there welcome to the lake house"
    assert cl.put(f"/api/videos/{vid}/gif", content=GIF).status_code == 200
    assert cl.put(f"/api/videos/{vid}/thumb", content=JPG).status_code == 200
    return vid


def test_full_send_open_watch_flow(env):
    app, store, sent = env
    staff = login(app, "staff@x.com", "password2")
    vid = make_video(staff)
    sh = staff.post(f"/api/videos/{vid}/shares", json={"recipient_name": "Jane Owner", "recipient_email": "jane@o.com", "channel": "email"}).json()
    assert sh["url"].endswith(sh["token"]) and "/g/" in sh["html"]

    recipient = TestClient(app)  # no sign-in cookie: a real recipient
    # The sender's own browser loading the preview (e.g. composing) is not an open.
    assert staff.get(f"/g/{sh['token']}.gif").content.startswith(b"GIF8")
    assert sent == []
    # A mail scanner is recorded but not alerted.
    recipient.get(f"/g/{sh['token']}.gif", headers={"user-agent": "Mimecast scanner"})
    assert sent == []
    # A person opening the email -> alert. A second open soon after -> no repeat alert.
    recipient.get(f"/g/{sh['token']}.gif", headers={"user-agent": "Mozilla/5.0 (via ggpht.com GoogleImageProxy)"})
    recipient.get(f"/g/{sh['token']}.gif", headers={"user-agent": "Mozilla/5.0 (via ggpht.com GoogleImageProxy)"})
    assert sent == [(2, "Jane Owner opened your email")]

    page = recipient.get(f"/v/{sh['token']}")
    assert page.status_code == 200 and "og:image" in page.text
    assert "Hi Jane" not in page.text and 'id="reply"' not in page.text  # just the video
    r = recipient.get(f"/m/{sh['token']}/video", headers={"range": "bytes=0-9"})
    assert r.status_code == 206 and r.content == b"0123456789"

    view = recipient.post(f"/e/{sh['token']}", json={"kind": "play"}).json()["view"]
    recipient.post(f"/e/{sh['token']}", json={"kind": "progress", "view": view, "buckets": "1" * 17 + "000"})
    recipient.post(f"/e/{sh['token']}", json={"kind": "comment", "text": "Looks great"})
    view2 = recipient.post(f"/e/{sh['token']}", json={"kind": "play"}).json()["view"]
    assert view2 != view
    titles = [t for _, t in sent]
    assert "Jane Owner is watching your video" in titles
    assert "Jane Owner is watching your video (view #2)" in titles
    assert "Jane Owner replied to your video" in titles

    d = staff.get(f"/api/videos/{vid}").json()
    assert d["opens"] == 1 and d["plays"] == 2  # the first Google image-server load is the send itself
    assert d["shares"][0]["best_percent"] == 85
    assert d["rewatch"][0] == 1 and d["rewatch"][19] == 0

    # The sender watching their own link is never counted.
    assert staff.post(f"/e/{sh['token']}", json={"kind": "play"}).json().get("self") is True


def test_staff_only_see_their_own_admin_sees_all(env):
    app, store, sent = env
    staff = login(app, "staff@x.com", "password2")
    boss = login(app, "boss@x.com", "password1")
    v_staff = make_video(staff)
    v_boss = make_video(boss)
    assert {v["id"] for v in staff.get("/api/videos").json()} == {v_staff}
    assert {v["id"] for v in boss.get("/api/videos").json()} == {v_staff, v_boss}
    assert staff.get(f"/api/videos/{v_boss}").status_code == 404
    assert staff.get("/api/users").status_code == 403
    assert boss.get("/api/users").status_code == 200


def test_password_and_expiry(env):
    app, store, sent = env
    staff = login(app, "staff@x.com", "password2")
    vid = make_video(staff)
    staff.patch(f"/api/videos/{vid}", json={"password": "lockbox"})
    tok = staff.post(f"/api/videos/{vid}/shares", json={"channel": "link"}).json()["token"]
    r = TestClient(app)
    assert "password protected" in r.get(f"/v/{tok}").text
    assert r.get(f"/m/{tok}/video").status_code == 403
    assert r.post(f"/v/{tok}/unlock", json={"password": "nope"}).status_code == 403
    assert r.post(f"/v/{tok}/unlock", json={"password": "lockbox"}).status_code == 200
    assert r.get(f"/m/{tok}/video").status_code == 200
    staff.patch(f"/api/videos/{vid}", json={"expires_at": time.time() - 10})
    assert r.get(f"/v/{tok}").status_code == 410


def test_invite_and_request_a_video(env):
    app, store, sent = env
    boss = login(app, "boss@x.com", "password1")
    inv = boss.post("/api/users", json={"name": "New Person", "email": "new@x.com"}).json()["invite_url"]
    tok = inv.rsplit("/", 1)[1]
    newbie = TestClient(app)
    assert newbie.get(f"/api/invite/{tok}").json()["name"] == "New Person"
    assert newbie.post(f"/api/invite/{tok}", json={"password": "longenough"}).status_code == 200
    assert newbie.get("/api/me").json()["role"] == "staff"
    assert newbie.post(f"/api/invite/{tok}", json={"password": "longenough"}).status_code == 404  # one use

    req = newbie.post("/api/requests", json={"title": "Show us the broken dishwasher"}).json()
    rtok = req["url"].rsplit("/", 1)[1]
    guest = TestClient(app)
    assert "broken dishwasher" in guest.get(f"/r/{rtok}").text
    start = guest.post(f"/r/{rtok}/start", json={"name": "Guest Gary", "mime": "video/mp4"}).json()
    assert guest.put(f"/r/{rtok}/chunk/{start['id']}?seq=0&key=wrong", content=b"x").status_code == 403
    assert guest.put(f"/r/{rtok}/chunk/{start['id']}?seq=0&key={start['key']}", content=b"abc").status_code == 200
    assert guest.post(f"/r/{rtok}/finish/{start['id']}?key={start['key']}", json={"duration": 3}).status_code == 200
    vids = newbie.get("/api/videos").json()
    assert vids[0]["received_from"] == "Guest Gary" and vids[0]["folder"] == "Received"
    assert ("New video from Guest Gary" in [t for _, t in sent])


def test_qr_and_contacts(env):
    app, store, sent = env
    staff = login(app, "staff@x.com", "password2")
    vid = make_video(staff)
    staff.post(f"/api/videos/{vid}/shares", json={"recipient_name": "Pat Prospect", "recipient_phone": "(404) 555-0101", "channel": "text"})
    assert staff.get("/api/contacts?q=pat").json()[0]["phone"] == "4045550101"
    r = staff.get(f"/api/videos/{vid}/qr.png")
    assert r.status_code == 200 and r.content.startswith(b"\x89PNG")


def test_cuts_confirm_approve_and_view_once(env):
    app, store, sent = env
    staff = login(app, "staff@x.com", "password2")
    vid = make_video(staff)
    v = staff.patch(f"/api/videos/{vid}", json={"skips": [[5, 7], [1, 2], [6, 9], [3, "x"]]}).json()
    assert v["skips"] == [[1.0, 2.0], [5.0, 9.0]]
    staff.patch(f"/api/videos/{vid}", json={"confirm_label": "I agree to the house rules", "reveal_text": "Door code 4821",
                                           "approve_buttons": True, "view_once": True})
    tok = staff.post(f"/api/videos/{vid}/shares", json={"recipient_name": "Gail Guest"}).json()["token"]
    page = TestClient(app).get(f"/v/{tok}").text
    assert "Door code 4821" not in page and "I agree to the house rules" in page

    guest = TestClient(app)
    guest.get(f"/v/{tok}")  # sets their viewer cookie
    assert guest.post(f"/e/{tok}", json={"kind": "confirm"}).json()["reveal"] == "Door code 4821"
    guest.post(f"/e/{tok}", json={"kind": "approve", "text": "Go ahead"})
    assert ("Gail Guest APPROVED" in [t for _, t in sent])
    guest.post(f"/e/{tok}", json={"kind": "play"})
    assert guest.get(f"/v/{tok}").status_code == 200          # same person can keep watching
    assert TestClient(app).get(f"/v/{tok}").status_code == 410  # anyone else: already viewed
    assert TestClient(app).get(f"/m/{tok}/video").status_code == 410


def test_manager_approval(env):
    app, store, sent = env
    boss = login(app, "boss@x.com", "password1")
    staff = login(app, "staff@x.com", "password2")
    boss.patch("/api/users/2", json={"needs_approval": True})
    vid = make_video(staff)
    assert staff.post(f"/api/videos/{vid}/shares", json={}).status_code == 409
    staff.post(f"/api/videos/{vid}/submit")
    assert ("Sam Staff needs a video approved" in [t for _, t in sent])
    assert staff.post(f"/api/videos/{vid}/approve", json={}).status_code == 403
    boss.post(f"/api/videos/{vid}/approve", json={"approve": True})
    assert staff.post(f"/api/videos/{vid}/shares", json={}).status_code == 200


def test_business_texting(env, monkeypatch):
    app, store, sent = env
    staff = login(app, "staff@x.com", "password2")
    vid = make_video(staff)
    assert staff.post(f"/api/videos/{vid}/sms", json={"recipient_phone": "4045550101"}).status_code == 409
    texts = []
    monkeypatch.setattr(alerts, "send_text", lambda settings, to, text: texts.append((to, text)) or "msg1")
    object.__setattr__(store.settings, "texting_enabled", True)
    object.__setattr__(store.settings, "telnyx_api_key", "k")
    object.__setattr__(store.settings, "text_from", "+15555550100")
    r = staff.post(f"/api/videos/{vid}/sms", json={"recipient_phone": "(404) 555-0101", "recipient_name": "Pat Owner"})
    assert r.status_code == 200, r.text
    assert texts[0][0] == "4045550101" and "Hi Pat" in texts[0][1] and r.json()["url"] in texts[0][1]
    assert alerts.normalize_phone("(404) 555-0101") == "+14045550101"


def test_testimonial_consent(env):
    app, store, sent = env
    staff = login(app, "staff@x.com", "password2")
    rtok = staff.post("/api/requests", json={"title": "Tell us about your stay", "testimonial": True}).json()["url"].rsplit("/", 1)[1]
    g = TestClient(app)
    assert "may share my video" in g.get(f"/r/{rtok}").text
    st = g.post(f"/r/{rtok}/start", json={"name": "Happy Guest", "consent": True}).json()
    g.put(f"/r/{rtok}/chunk/{st['id']}?seq=0&key={st['key']}", content=b"abc")
    g.post(f"/r/{rtok}/finish/{st['id']}?key={st['key']}", json={})
    v = staff.get("/api/videos").json()[0]
    assert v["folder"] == "Testimonials" and v["consent"] == 1


def _png(w=40, h=30):
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


def test_screenshots_edit_and_sharex(env):
    app, store, sent = env
    staff = login(app, "staff@x.com", "password2")
    vid = staff.post("/api/videos", json={"mime": "image/png", "title": "Owner statement", "source_url": "https://x.com"}).json()["id"]
    staff.put(f"/api/videos/{vid}/chunk?seq=0", content=_png())
    v = staff.post(f"/api/videos/{vid}/finish", json={"title": "Owner statement"}).json()
    assert v["kind"] == "image" and v["source_url"] == "https://x.com"
    # Edit: the untouched capture is kept; the edited one is what people see.
    edited = _png(50, 50)
    staff.put(f"/api/videos/{vid}/edit?seq=0", content=edited)
    staff.post(f"/api/videos/{vid}/edit/finish", json={"mime": "image/png", "edit_json": '{"items":[]}'})
    assert staff.get(f"/api/videos/{vid}/file").content == edited
    assert staff.get(f"/api/videos/{vid}/original").content == _png()
    staff.patch(f"/api/videos/{vid}", json={"transcript": "Net payout 4,210.55"})
    assert staff.get("/api/videos?q=payout&kind=image").json()[0]["id"] == vid
    tok = staff.post(f"/api/videos/{vid}/shares", json={"recipient_name": "Olive Owner"}).json()["token"]
    page = TestClient(app).get(f"/v/{tok}").text
    assert 'id="pic"' in page and "<video" not in page
    viewer = TestClient(app)
    viewer.post(f"/e/{tok}", json={"kind": "play"})
    assert ("Olive Owner is looking at your screenshot" in [t for _, t in sent])
    assert viewer.get(f"/g/{tok}.gif").headers["content-type"].startswith("image/")

    # ShareX: download the setup file, then upload with its key, no sign-in needed.
    cfg = staff.get("/api/sharex/config").json()
    assert cfg["RequestURL"].endswith("/api/sharex/upload")
    key = cfg["Headers"]["Authorization"]
    anon = TestClient(app)
    assert anon.post("/api/sharex/upload", files={"file": ("a.png", _png(), "image/png")}).status_code == 401
    r = anon.post("/api/sharex/upload", headers={"Authorization": key},
                  files={"file": ("Desktop shot.png", _png(800, 2000), "image/png")})
    assert r.status_code == 200, r.text
    assert "/v/" in r.json()["url"]
    items = staff.get("/api/videos?kind=image").json()
    shot = [i for i in items if i["title"] == "Desktop shot"][0]
    assert shot["has_thumb"] == 1 and shot["folder"] == "Screenshots"


def test_sign_in_without_cookies(env):
    """Phones whose browser drops cookies: the key in the body works as a header,
    and the viewing-only key works for pictures/videos but nothing else."""
    app, store, sent = env
    staff = login(app, "staff@x.com", "password2")
    vid = make_video(staff)
    data = TestClient(app).post("/api/login", json={"email": "staff@x.com", "password": "password2"}).json()
    phone = TestClient(app)  # no cookies at all
    assert phone.get("/api/me").status_code == 401
    assert phone.get("/api/me", headers={"X-Session": data["session"]}).json()["name"] == "Sam Staff"
    assert phone.get(f"/api/videos/{vid}/file?mk={data['media_key']}").status_code == 200
    assert phone.get(f"/api/videos?mk={data['media_key']}").status_code == 401  # only picture/video files
    assert phone.post("/api/videos", json={"mime": "video/mp4"}, params={"mk": data["media_key"]}).status_code == 401
    assert phone.delete(f"/api/videos/{vid}?mk={data['media_key']}").status_code == 401


def test_screenpal_features(env):
    app, store, sent = env
    staff = login(app, "staff@x.com", "password2")
    vid = make_video(staff, b"OLD" * 1000)
    tok = staff.post(f"/api/videos/{vid}/shares", json={"recipient_name": "Gail Guest"}).json()["token"]
    # Replace the video: the old link now plays the new take.
    new = make_video(staff, b"NEW" * 1000)
    staff.post(f"/api/videos/{vid}/replace-with/{new}")
    assert TestClient(app).get(f"/m/{tok}/video").content.startswith(b"NEW")
    assert staff.get(f"/api/videos/{new}").status_code == 404
    # Chapters, questions, answers.
    v = staff.patch(f"/api/videos/{vid}", json={
        "chapters": [{"t": 30, "title": "Hot tub"}, {"t": 0, "title": "Intro"}, {"t": 5, "title": ""}],
        "questions": [{"type": "rating", "q": "How was your stay?"}, {"type": "choice", "q": "Lockbox OK?", "options": ["Yes", "No"], "t": 3},
                      {"type": "choice", "q": "Bad", "options": ["only one"]}]}).json()
    assert [c["title"] for c in v["chapters"]] == ["Intro", "Hot tub"]
    assert len(v["questions"]) == 2
    guest = TestClient(app)
    page = guest.get(f"/v/{tok}").text
    assert "chapters" in page and "How was your stay?" in page
    qid = v["questions"][0]["id"]
    assert guest.post(f"/e/{tok}", json={"kind": "answer", "id": qid, "a": 9}).status_code == 200  # capped at 5
    assert guest.post(f"/e/{tok}", json={"kind": "answer", "id": v["questions"][1]["id"], "a": "Maybe"}).status_code == 400
    d = staff.get(f"/api/videos/{vid}").json()
    assert d["answers"][qid][0]["a"] == 5
    assert ("Gail Guest answered: How was your stay?" in [t for _, t in sent])
    # Website embed: just the player.
    emb = guest.get(f"/v/{tok}?embed=1").text
    assert 'class="embed"' in emb and "Reply to" not in emb
    # Not watchable before its go-live date (the sender can still preview).
    staff.patch(f"/api/videos/{vid}", json={"publish_at": time.time() + 86400})
    assert "will be ready on" in TestClient(app).get(f"/v/{tok}").text
    assert TestClient(app).get(f"/m/{tok}/video").status_code == 403
    assert staff.get(f"/v/{tok}").status_code == 200
    staff.patch(f"/api/videos/{vid}", json={"publish_at": None})
    # Playlists: one page, each video tracked.
    other = make_video(staff)
    p = staff.post("/api/playlists", json={"title": "Lake House guide"}).json()
    p = staff.patch(f"/api/playlists/{p['id']}", json={"videos": [other, vid]}).json()
    assert [i["id"] for i in p["items"]] == [other, vid]
    pg = TestClient(app).get(f"/p/{p['id']}").text
    assert "Lake House guide" in pg and p["items"][0]["share_token"] in pg
    assert staff.get(f"/api/playlists/{p['id']}/qr.png").content.startswith(b"\x89PNG")
    # Reports.
    r = staff.get("/api/reports?days=7").json()
    assert len(r["days"]) == 7 and r["sent"] >= 1
    assert d["totals"]["views"] == 0


def test_gmail_send_is_not_an_open(env):
    """Gmail fetches the preview through Google's image server the moment it sends;
    that first fetch is the send, not the recipient."""
    app, store, sent = env
    staff = login(app, "staff@x.com", "password2")
    vid = make_video(staff)
    tok = staff.post(f"/api/videos/{vid}/shares", json={"recipient_name": "Jordan + 3 others", "channel": "email"}).json()["token"]
    proxy = {"user-agent": "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)"}
    TestClient(app).get(f"/g/{tok}.gif", headers=proxy)
    assert sent == []
    TestClient(app).get(f"/g/{tok}.gif", headers=proxy)
    assert sent == [(2, "Jordan + 3 others opened your email")]


def test_company_name_is_a_setting(tmp_path, monkeypatch):
    monkeypatch.setenv("VIDEO_EMAIL_HOME", str(tmp_path))
    monkeypatch.setenv("PUBLIC_URL", "http://testserver")
    monkeypatch.setenv("COMPANY_NAME", "Bob's Cabins")
    cl = TestClient(appmod.create_app(Store(config.load())))
    for url in ("/app", "/sw.js", "/manifest.webmanifest", "/static/app.js", "/static/gmail-button-help.html"):
        r = cl.get(url)
        assert r.status_code == 200, url
        assert "__COMPANY__" not in r.text, url
        assert "Bob’s Cabins" in r.text, url
    assert cl.get("/static/app.css").status_code == 200
    assert cl.get("/static/icon-192.png").status_code == 200
    assert cl.get("/static/..%2f..%2fconfig.py").status_code in (400, 404)
