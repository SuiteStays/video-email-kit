"""Server-rendered pages for recipients: the watch page and the
"record a video for us" page. Server-rendered so texts and emails show a
proper preview card (title + thumbnail) when the link is pasted."""
from __future__ import annotations

import html
import json


def _e(text) -> str:
    return html.escape(str(text or ""), quote=True)


def _head(title: str, extra: str = "") -> str:
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{_e(title)}</title>
<link rel="stylesheet" href="/static/watch.css?v=8">
{extra}
</head>"""


def _brand(company: str) -> str:
    return f'<header class="brand"><span class="logo">{_e(company)}</span></header>'


def message_page(company: str, message: str) -> str:
    return (_head(company) + f'<body>{_brand(company)}<main class="wrap"><div class="card msg">'
            f"<p>{_e(message)}</p></div></main></body></html>")


def watch_page(*, company: str, company_url: str = "", public_url: str, share: dict, video: dict, owner: dict, locked: bool,
               embed: bool = False) -> str:
    tok = share["token"]
    title = video["title"] or "A video for you"
    greeting = f"Hi {share['recipient_name'].split()[0]}," if share.get("recipient_name") else ""
    og = (
        f'<meta property="og:title" content="A video from {_e(owner["name"])}">'
        f'<meta property="og:description" content="A video from {_e(owner["name"])} at {_e(company)}">'
        f'<meta property="og:image" content="{_e(public_url)}/t/{_e(tok)}.jpg">'
        f'<meta property="og:type" content="video.other">'
        f'<meta name="twitter:card" content="summary_large_image">'
    )
    cfg = {
        "token": tok,
        "trimStart": video["trim_start"] or 0,
        "trimEnd": video["trim_end"] or 0,
        "duration": video["duration"] or 0,
        "locked": locked,
        "cta": video["cta_label"],
        "skips": video.get("skips") or [],
        "confirm": video.get("confirm_label") or "",
        "approve": bool(video.get("approve_buttons")),
        "chapters": video.get("chapters") or [],
        "questions": video.get("questions") or [],
        "hasCaptions": bool((video.get("captions") or "").strip().count("-->")),
    }
    extras = ""
    if video.get("confirm_label") and not locked:
        extras += (
            '<div class="card confirm" id="confirmbox"><p class="muted" id="confirmhint">Please watch the video, then confirm below.</p>'
            f'<button class="primary" id="confirm" type="button" disabled>{_e(video["confirm_label"])}</button>'
            '<div class="reveal" id="reveal" hidden></div></div>'
        )
    if video.get("approve_buttons") and not locked:
        extras += (
            '<div class="card" id="approvebox"><label for="approvenote">Your decision</label>'
            '<textarea id="approvenote" rows="2" placeholder="Add a note (optional)" maxlength="2000"></textarea>'
            '<div class="choices"><button class="primary approve" id="approve" type="button">&#10004; Approve</button>'
            '<button class="secondary" id="decline" type="button">&#10006; Decline</button></div>'
            '<p class="ok" id="approveok" hidden></p></div>'
        )
    contact = []
    if owner.get("phone"):
        contact.append(f'<a href="tel:{_e(owner["phone"])}">{_e(owner["phone"])}</a>')
    if owner.get("email"):
        contact.append(f'<a href="mailto:{_e(owner["email"])}">{_e(owner["email"])}</a>')
    initials = "".join(p[0] for p in owner["name"].split()[:2]).upper()
    cta = ""
    if video["cta_label"] and video["cta_url"]:
        cta = (f'<a class="cta" id="cta" href="{_e(video["cta_url"])}" target="_blank" rel="noopener">'
               f'{_e(video["cta_label"])}</a>')
    # Under the video: the sender's email signature picture, or a simple name card.
    if owner.get("signature"):
        signature_block = (
            f'<div class="sigwrap">'
            + (f'<a href="{_e(company_url)}" target="_blank" rel="noopener">' if company_url else "")
            + f'<img class="sig" src="{_e(owner["signature"])}" alt="{_e(owner["name"])} - {_e(company)}">'
            + ("</a>" if company_url else "")
            + f'{f"<div class=actions>{cta}</div>" if cta else ""}</div>'
        )
    else:
        signature_block = (
            f'<div class="below"><div class="sender"><div class="avatar">{_e(initials)}</div>'
            f'<div><div class="sname">{_e(owner["name"])}</div><div class="scontact">{" &middot; ".join(contact)}</div></div></div>'
            f'<div class="actions">{cta}</div></div>'
        )
    cfg["image"] = video.get("kind") == "image"
    picture = (
        f'<div class="picture"><a href="/m/{_e(tok)}/video" target="_blank" rel="noopener" title="Open full size">'
        f'<img id="pic" src="/m/{_e(tok)}/video" alt="{_e(title)}"></a>'
        '<p class="muted small">Tap the picture to open it full size.</p></div>'
    )
    player = (
        '<div class="locked" id="lockbox"><p>This is password protected.</p>'
        '<form id="unlock"><input type="password" id="pw" placeholder="Password" autocomplete="off" required>'
        '<button type="submit">Open</button></form><p class="err" id="pwerr"></p></div>'
        if locked and cfg["image"] else picture if cfg["image"] else
        '<div class="locked" id="lockbox"><p>This video is password protected.</p>'
        '<form id="unlock"><input type="password" id="pw" placeholder="Password" autocomplete="off" required>'
        '<button type="submit">Watch</button></form><p class="err" id="pwerr"></p></div>'
        if locked else
        f'<div class="player"><video id="vid" playsinline preload="metadata" poster="/t/{_e(tok)}.jpg">'
        f'<source src="/m/{_e(tok)}/video" type="{_e(video["mime"])}">'
        f'<track kind="captions" src="/m/{_e(tok)}/captions.vtt" srclang="en" label="Captions">'
        f'</video><button class="bigplay" id="bigplay" aria-label="Play">&#9654;</button>'
        '<div class="quizlay" id="quizlay" hidden></div></div>'
    )
    # Chapters (jump to a part) and the words that were said, under the player.
    below_player = ""
    if not locked and not cfg["image"]:
        if cfg["chapters"]:
            below_player += '<div class="chapters" id="chapters"></div>'
        if cfg["hasCaptions"] and not embed and video.get("show_transcript"):
            below_player += ('<details class="card transcript"><summary>Read along (what was said)</summary>'
                             '<div id="transcript"></div></details>')
    if cfg["questions"] and not locked:
        below_player += '<div class="card" id="quiz" hidden></div>'
    script = (f"<script>window.WATCH = {json.dumps(cfg)};</script>"
              '<script src="/static/watch.js?v=8"></script>')
    if embed:  # for a website: just the player, chapters, questions and the button
        return _head(f"A video from {owner['name']}", og) + f"""<body class="embed">
<main class="wrap embedwrap">{player}{below_player}
  {f'<div class="actions" style="margin-top:10px">{cta}</div>' if cta else ''}
</main>{script}</body></html>"""
    fit = ' class="fit"' if owner.get("signature") and not cfg["image"] else ""
    return _head(f"A video from {owner['name']}", og) + f"""<body{fit}>
{_brand(company)}
<main class="wrap">
  {player}
  {below_player}
  {signature_block}
  {extras}
</main>
{script}
</body></html>"""


def request_page(company: str, req: dict, owner_name: str) -> str:
    cfg = {"token": req["token"]}
    return _head(req["title"]) + f"""<body>
{_brand(company)}
<main class="wrap narrow">
  <h1>{_e(req['title'])}</h1>
  {f'<p class="lead">{_e(req["message"])}</p>' if req.get('message') else ''}
  <p class="muted">{_e(owner_name)} at {_e(company)} asked for a short video. No account or app needed.</p>
  <div class="card" id="step1">
    <label for="rname">Your name</label>
    <input id="rname" autocomplete="name" placeholder="Your name" required>
    <label for="rnote">Anything to add? (optional)</label>
    <textarea id="rnote" rows="2" placeholder="Optional note"></textarea>
    {'<label class="check"><input type="checkbox" id="consent"> ' + _e(company) + ' may share my video on its website and social media.</label>' if req.get('testimonial') else ''}
    <div class="choices">
      <button class="primary" id="recbtn" type="button">&#127909; Record now</button>
      <label class="secondary filepick">&#128193; Choose a video
        <input type="file" id="file" accept="video/*" capture="environment" hidden></label>
    </div>
  </div>
  <div class="card" id="recorder" hidden>
    <video id="live" playsinline muted autoplay></video>
    <div class="choices">
      <button class="secondary" id="flip" type="button">Switch camera</button>
      <button class="primary" id="startstop" type="button">Start recording</button>
    </div>
    <p class="timer" id="timer"></p>
  </div>
  <div class="card" id="review" hidden>
    <video id="playback" playsinline controls></video>
    <div class="choices">
      <button class="secondary" id="redo" type="button">Record again</button>
      <button class="primary" id="send" type="button">Send video</button>
    </div>
  </div>
  <div class="card" id="progress" hidden>
    <p>Sending your video... please keep this page open.</p>
    <div class="bar"><div id="barfill"></div></div>
  </div>
  <div class="card msg" id="done" hidden><p>&#10004; Thank you! Your video was sent to {_e(owner_name)}.</p></div>
  <p class="err" id="err"></p>
</main>
<footer class="foot">{_e(company)}</footer>
<script>window.REQ = {json.dumps(cfg)};</script>
<script src="/static/common.js?v=4"></script>
<script src="/static/request.js?v=3"></script>
</body></html>"""


def playlist_page(company: str, playlist: dict, items: list, owner: dict) -> str:
    """One page per property: every video for it, in order. Each video plays in
    the normal watch page (embedded), so views are tracked as usual."""
    title = playlist["title"]
    if not items:
        return message_page(company, "There are no videos here yet.")
    rows = "".join(
        f'<button class="pitem{" on" if i == 0 else ""}" data-src="/v/{_e(it["share_token"])}?embed=1">'
        f'<span class="pnum">{i + 1}</span><span class="ptitle">{_e(it["title"])}</span>'
        f'<span class="pdur">{"" if it["kind"] == "image" else _fmt(it["duration"])}</span></button>'
        for i, it in enumerate(items)
    )
    contact = " &middot; ".join(
        x for x in (f'<a href="tel:{_e(owner["phone"])}">{_e(owner["phone"])}</a>' if owner.get("phone") else "",
                    f'<a href="mailto:{_e(owner["email"])}">{_e(owner["email"])}</a>' if owner.get("email") else "") if x)
    first = f'/v/{_e(items[0]["share_token"])}?embed=1'
    return _head(title) + f"""<body>
{_brand(company)}
<main class="wrap wide">
  <h1>{_e(title)}</h1>
  {f'<p class="lead">{_e(playlist["description"])}</p>' if playlist.get("description") else ''}
  <div class="playlist">
    <div class="pframe"><iframe id="pframe" src="{first}" title="Video" allow="fullscreen; autoplay" allowfullscreen></iframe></div>
    <div class="plist">{rows}</div>
  </div>
  <p class="muted small">Questions? {_e(owner["name"])} &middot; {contact}</p>
</main>
<footer class="foot">{_e(company)}</footer>
<script>
document.querySelectorAll(".pitem").forEach(function (b) {{
  b.addEventListener("click", function () {{
    document.querySelectorAll(".pitem").forEach(function (x) {{ x.classList.toggle("on", x === b); }});
    document.getElementById("pframe").src = b.dataset.src;
    if (window.innerWidth < 800) window.scrollTo({{ top: 0, behavior: "smooth" }});
  }});
}});
</script>
</body></html>"""


def _fmt(sec) -> str:
    sec = int(round(sec or 0))
    return f"{sec // 60}:{sec % 60:02d}"
