// __COMPANY__ Video -- the program staff use.
import { GIFEncoder, quantize, applyPalette } from "./gifenc.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let me = null;
let pollTimer = null;

// ------------------------------------------------------------------ basics

async function api(method, url, body) {
  const opts = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  if (r.status === 401 && !url.startsWith("/api/login") && !url.startsWith("/api/invite")) {
    me = null; location.hash = "#/login"; throw new Error("Please sign in");
  }
  const data = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.detail) || "Something went wrong");
  return data;
}

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function modal(html) {
  const m = $("#modal");
  $("#modal-card").innerHTML = html;
  m.hidden = false;
  m.onclick = (e) => { if (e.target === m) closeModal(); };
  return $("#modal-card");
}
function closeModal() { $("#modal").hidden = true; $("#modal-card").innerHTML = ""; }

function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " hr ago";
  return new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
const when = (ts) => new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const whoOf = (e) => e.recipient_name || e.recipient_email || e.recipient_phone || "Someone";

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) { window.prompt("Copy this:", text); return false; }
}
async function copyHtml(html, text) {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([text], { type: "text/plain" }),
    })]);
    return true;
  } catch (e) { return copyText(text); }
}

// ------------------------------------------------------------------ router

const routes = {
  login: renderLogin, invite: renderInvite, "": renderLibrary, record: renderRecord, video: renderVideo,
  activity: renderActivity, requests: renderRequests, team: renderTeam, settings: renderSettings, pick: renderPick,
  shared: renderShared, playlists: renderPlaylists, reports: renderReports,
  edit: async (id, params) => (await import("./editor.js?v=11")).renderEditor(view, id, { api, esc, toast, modal, closeModal, copyText, params }),
  capture: async () => (await import("./editor.js?v=11")).renderScreenGrab(view, { api, toast }),
};

// A video shared from the phone's gallery (Android): the service worker kept it; upload it now.
async function renderShared() {
  view.innerHTML = `<p class="muted">Getting the shared video...</p>`;
  const cache = await caches.open("ss-share");
  const res = await cache.match("/shared-video");
  if (!res) { location.hash = "#/"; return; }
  const blob = await res.blob();
  await cache.delete("/shared-video");
  const name = decodeURIComponent(res.headers.get("x-filename") || "Shared%20video.mp4");
  location.hash = "#/";
  await new Promise((r) => setTimeout(r, 300));
  uploadExisting(new File([blob], name, { type: blob.type || "video/mp4" }));
}

async function route() {
  clearInterval(pollTimer);
  if (window.__stopRecorder) window.__stopRecorder();
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const [name, arg] = path.split("/");
  const params = new URLSearchParams(query || "");
  if (name !== "login" && name !== "invite" && !me) {
    try { me = await api("GET", "/api/me"); if (me.media_key) SS.keepSession({ media_key: me.media_key }); } catch (e) { return; }
  }
  document.body.classList.toggle("admin", me?.role === "admin");
  if (me && name !== "pick") alertsBanner();
  $("#top").hidden = !me || name === "login" || name === "invite" || sessionStorage.getItem("pick");
  $$("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.nav === (name || "library")));
  const fn = routes[name] || renderLibrary;
  view.innerHTML = "";
  try { await fn(arg, params); }
  catch (e) { view.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------ sign-in

function renderLogin() {
  me = null;
  $("#top").hidden = true;
  view.innerHTML = `
    <div class="auth card">
      <span class="logo">__COMPANY__ <span>Video</span></span>
      <form id="f">
        <label>Email</label><input type="email" id="email" autocomplete="username" required>
        <label>Password</label><input type="password" id="pw" autocomplete="current-password" required>
        <p class="err" id="err"></p>
        <button class="btn primary big" style="width:100%">Sign in</button>
      </form>
    </div>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    try {
      SS.keepSession(await api("POST", "/api/login", { email: $("#email").value, password: $("#pw").value }));
      me = await api("GET", "/api/me");
      location.hash = sessionStorage.getItem("pick") ? "#/pick" : "#/";
    } catch (err) { $("#err").textContent = err.message; }
  };
}

async function renderInvite(tok) {
  $("#top").hidden = true;
  let info;
  try { info = await api("GET", "/api/invite/" + tok); }
  catch (e) {
    view.innerHTML = `<div class="auth card"><p class="err">${esc(e.message)}</p><a class="btn" href="#/login">Go to sign in</a></div>`;
    return;
  }
  view.innerHTML = `
    <div class="auth card">
      <span class="logo">__COMPANY__ <span>Video</span></span>
      <p>Welcome, <b>${esc(info.name)}</b>. Choose a password for <b>${esc(info.email)}</b>.</p>
      <form id="f">
        <label>New password (8+ characters)</label><input type="password" id="pw" autocomplete="new-password" minlength="8" required>
        <label>Type it again</label><input type="password" id="pw2" autocomplete="new-password" required>
        <p class="err" id="err"></p>
        <button class="btn primary big" style="width:100%">Save and continue</button>
      </form>
    </div>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    if ($("#pw").value !== $("#pw2").value) { $("#err").textContent = "The two passwords don't match."; return; }
    try {
      SS.keepSession(await api("POST", "/api/invite/" + tok, { password: $("#pw").value }));
      me = await api("GET", "/api/me");
      location.hash = "#/settings";
      toast("You're in. Turn on alerts below.");
    } catch (err) { $("#err").textContent = err.message; }
  };
}

// ------------------------------------------------------------------ library

async function renderLibrary() {
  const folders = await api("GET", "/api/folders");
  view.innerHTML = `
    <div class="row spread"><h1>${me.role === "admin" ? "All videos" : "My videos"}</h1>
      <div class="row"><label class="btn" style="margin:0">&#8679; Upload<input type="file" id="upfile" accept="video/*,image/*" hidden></label>
      <a class="btn rec big" href="#/record">&#9679; Record a video</a></div></div>
    <div class="toolbar">
      <input id="q" placeholder="Search titles and what was said...">
      <select id="kind" style="max-width:170px"><option value="">Videos and screenshots</option><option value="video">Videos only</option><option value="image">Screenshots only</option></select>
      <select id="folder"><option value="">All folders</option>${folders.map((f) => `<option>${esc(f)}</option>`).join("")}<option>Received</option><option>Screenshots</option><option>Testimonials</option></select>
      <a class="btn" href="#/capture">&#128247; Screenshot</a>
      ${me.role === "admin" ? `<label class="check" style="margin:0"><input type="checkbox" id="mine"> Only mine</label>` : ""}
    </div>
    <div id="tiles" class="tiles"></div>`;
  const load = async () => {
    const qs = new URLSearchParams({ q: $("#q").value, folder: $("#folder").value, mine: $("#mine")?.checked ? 1 : 0, kind: $("#kind").value });
    const vids = await api("GET", "/api/videos?" + qs);
    $("#tiles").innerHTML = vids.length ? vids.map(tile).join("") :
      `<div class="empty" style="grid-column:1/-1"><p>No videos yet.</p><a class="btn rec big" href="#/record">&#9679; Record your first video</a></div>`;
  };
  let t; $("#q").oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  $("#folder").onchange = load;
  $("#kind").onchange = load;
  if ($("#mine")) $("#mine").onchange = load;
  $("#upfile").onchange = () => uploadExisting($("#upfile").files[0]);
  await load();
}

function tile(v) {
  return `<a class="tile" href="#/video/${v.id}">
    <div class="thumb" style="background-image:url('/api/videos/${v.id}/thumb.jpg${SS.mk()}');${v.kind === "image" ? "background-position:top" : ""}"><span class="dur">${v.kind === "image" ? (v.mime === "image/gif" ? "GIF" : "&#128247;") : SS.fmtTime(v.duration)}</span></div>
    <div class="meta"><div class="title">${esc(v.title)}</div>
      <div class="stats"><span>&#128065; ${v.plays} views</span><span>&#9993; ${v.opens} opens</span>
      ${v.needs_manager ? `<span class="pill warn">${v.approval === "pending" ? "awaiting approval" : "needs approval"}</span>` : ""}
      ${v.received_from ? `<span class="pill">from ${esc(v.received_from)}</span>` : v.folder ? `<span class="pill">${esc(v.folder)}</span>` : ""}</div>
      <div class="small muted">${me.role === "admin" ? esc(v.owner_name) + " &middot; " : ""}${ago(v.created_at)}</div></div></a>`;
}

async function uploadExisting(file, replaceId = null) {
  if (!file) return;
  const card = modal(`<h2>Uploading ${esc(file.name)}</h2><div class="bar" style="height:10px;background:#e3e8ee;border-radius:6px;overflow:hidden">
    <div id="ubar" style="height:100%;width:0;background:#0f5c8c"></div></div><p class="muted small" id="ustat">Starting...</p>`);
  try {
    const { id } = await api("POST", "/api/videos", { mime: file.type || "video/mp4", title: file.name.replace(/\.[^.]+$/, "") });
    await SS.uploadInPieces(file, (seq) => `/api/videos/${id}/chunk?seq=${seq}`,
      (p) => { $("#ubar", card).style.width = Math.round(p * 100) + "%"; $("#ustat", card).textContent = Math.round(p * 100) + "%"; });
    if (file.type.startsWith("image/")) {
      await api("POST", `/api/videos/${id}/finish`, { title: file.name.replace(/\.[^.]+$/, "") });
      closeModal();
      location.hash = file.type === "image/gif" ? "#/video/" + id : "#/edit/" + id;
      return;
    }
    $("#ustat", card).textContent = "Making the email preview...";
    const tmp = document.createElement("video"); tmp.muted = true;
    const duration = await SS.loadBlob(tmp, file);
    await api("POST", `/api/videos/${id}/finish`, { duration: isFinite(duration) ? duration : 0, title: file.name.replace(/\.[^.]+$/, "") });
    await makePreviews(id, tmp, 0);
    if (replaceId) { await api("POST", `/api/videos/${replaceId}/replace-with/${id}`); closeModal(); toast("Video replaced - every link now shows the new one"); location.hash = "#/video/" + replaceId; renderVideo(replaceId); return; }
    closeModal();
    location.hash = "#/video/" + id;
  } catch (e) { $("#ustat", card).textContent = "Upload failed: " + e.message; }
}

// ------------------------------------------------------------------ previews (thumbnail + moving GIF)

async function makePreviews(id, video, startAt) {
  const dur = isFinite(video.duration) ? video.duration : 0;
  const t0 = Math.min(Math.max(0, startAt || 0), Math.max(0, dur - 0.5));
  await SS.seek(video, Math.min(t0 + 0.5, dur || 0.5));
  const thumb = await SS.frameToJpeg(video);
  await fetch(`/api/videos/${id}/thumb`, { method: "PUT", body: thumb, credentials: "same-origin" });
  const gif = await makeGif(video, t0);
  await fetch(`/api/videos/${id}/gif`, { method: "PUT", body: gif, credentials: "same-origin" });
}

// A 3-second moving preview with a play button, like Vidyard and BombBomb.
async function makeGif(video, start) {
  const W = 400;
  const H = Math.round(W * ((video.videoHeight || 720) / (video.videoWidth || 1280)));
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const gif = GIFEncoder();
  const dur = isFinite(video.duration) ? video.duration : 3;
  const frames = 24, step = 0.125;
  for (let i = 0; i < frames; i++) {
    const t = Math.min(start + i * step, Math.max(0, dur - 0.05));
    await SS.seek(video, t);
    ctx.drawImage(video, 0, 0, W, H);
    drawPlayButton(ctx, W, H);
    const { data } = ctx.getImageData(0, 0, W, H);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), W, H, { palette, delay: 125, repeat: i === 0 ? 0 : undefined });
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: "image/gif" });
}

function drawPlayButton(ctx, W, H) {
  const r = Math.round(Math.min(W, H) * 0.13);
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath(); ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#0f5c8c";
  ctx.beginPath();
  ctx.moveTo(W / 2 - r * 0.32, H / 2 - r * 0.45);
  ctx.lineTo(W / 2 - r * 0.32, H / 2 + r * 0.45);
  ctx.lineTo(W / 2 + r * 0.5, H / 2);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------------ background blur

// Runs on the computer's own graphics chip (free). The person-finding model
// loads once, the first time blur is switched on.
const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
let segmenterPromise = null;
function getSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const vision = await import(MP + "/vision_bundle.mjs");
      const files = await vision.FilesetResolver.forVisionTasks(MP + "/wasm");
      return vision.ImageSegmenter.createFromOptions(files, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
          delegate: "GPU",
        },
        runningMode: "VIDEO", outputCategoryMask: false, outputConfidenceMasks: true,
      });
    })();
    segmenterPromise.catch(() => { segmenterPromise = null; });
  }
  return segmenterPromise;
}

function ticker(fps = 30) {
  return new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${Math.round(1000 / fps)})`], { type: "text/javascript" })));
}

// Camera stream in, camera stream with a blurred background out.
async function blurStream(cam) {
  const seg = await getSegmenter();
  const v = document.createElement("video"); v.srcObject = cam; v.muted = true; v.playsInline = true; await v.play();
  const W = v.videoWidth || 1280, H = v.videoHeight || 720;
  const out = document.createElement("canvas"); out.width = W; out.height = H;
  const ctx = out.getContext("2d");
  const person = document.createElement("canvas"); person.width = W; person.height = H;
  const pctx = person.getContext("2d");
  const maskC = document.createElement("canvas");
  const mctx = maskC.getContext("2d");
  let last = -1;
  const tick = ticker(30);
  tick.onmessage = () => {
    if (!v.videoWidth) return;
    const ts = performance.now();
    if (ts <= last) return;
    last = ts;
    seg.segmentForVideo(v, ts, (res) => {
      const masks = res.confidenceMasks || [];
      const m = masks[masks.length > 1 ? 1 : 0];
      if (!m) return;
      const data = m.getAsFloat32Array();
      if (maskC.width !== m.width) { maskC.width = m.width; maskC.height = m.height; }
      const img = mctx.createImageData(m.width, m.height);
      for (let i = 0; i < data.length; i++) { img.data[i * 4 + 3] = Math.min(255, data[i] * 320); }
      mctx.putImageData(img, 0, 0);
      ctx.filter = "blur(16px)"; ctx.drawImage(v, 0, 0, W, H); ctx.filter = "none";
      pctx.globalCompositeOperation = "copy"; pctx.drawImage(v, 0, 0, W, H);
      pctx.globalCompositeOperation = "destination-in"; pctx.drawImage(maskC, 0, 0, W, H);
      ctx.drawImage(person, 0, 0);
    });
  };
  const s = out.captureStream(30);
  cam.getAudioTracks().forEach((t) => s.addTrack(t));
  s.stopBlur = () => { tick.terminate(); v.srcObject = null; };
  return s;
}

// ------------------------------------------------------------------ recorder

async function renderRecord(arg, params = new URLSearchParams()) {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const cams = devices.filter((d) => d.kind === "videoinput");
  const mics = devices.filter((d) => d.kind === "audioinput");
  const canScreen = !!navigator.mediaDevices?.getDisplayMedia;
  const mime = SS.pickMime();
  view.innerHTML = `
    <h1>Record a video</h1>
    ${mime ? "" : `<div class="card"><p class="err">This browser can't record video. Use Chrome or Edge on a computer, or upload a video from your phone.</p></div>`}
    <div class="modes">
      <button class="mode on" data-mode="camera"><span class="ico">&#127909;</span>Camera</button>
      <button class="mode" data-mode="screen" ${canScreen ? "" : "disabled"}><span class="ico">&#128421;</span>Screen</button>
      <button class="mode" data-mode="both" ${canScreen ? "" : "disabled"}><span class="ico">&#128100;</span>Screen + Camera</button>
    </div>
    <div class="stage" id="stage">
      <video id="preview" autoplay muted playsinline></video>
      <div class="prompter" id="prompter" hidden><div class="prompter-text" id="ptext"></div></div>
      <div class="hint" id="hint" hidden></div>
      <div class="count" id="count" hidden></div>
    </div>
    <div class="controls" id="controls">
      <button class="btn rec big" id="go" ${mime ? "" : "disabled"}>&#9679; Start recording</button>
    </div>
    <div class="controls" id="live" hidden>
      <span class="recdot"></span><span class="clock" id="clock">0:00</span>
      <button class="btn" id="pause">&#10073;&#10073; Pause</button>
      <button class="btn" id="restart">&#8635; Start over</button>
      <button class="btn rec big" id="stop">&#9632; Stop</button>
    </div>
    <div class="card" id="opts">
      <div class="opts">
        <div><label>Camera</label><select id="cam">${cams.map((d, i) => `<option value="${d.deviceId}">${esc(d.label || "Camera " + (i + 1))}</option>`).join("")}</select></div>
        <div><label>Microphone</label><select id="mic">${mics.map((d, i) => `<option value="${d.deviceId}">${esc(d.label || "Microphone " + (i + 1))}</option>`).join("")}</select></div>
        <div><label>Folder</label><select id="rfolder"><option value="">No folder</option>${(await api("GET", "/api/folders")).map((f) => `<option>${esc(f)}</option>`).join("")}</select></div>
      </div>
      <label class="check"><input type="checkbox" id="blur"> Blur my background <span class="small muted" id="blurstat"></span></label>
      <label class="check"><input type="checkbox" id="asgif"> Save as a GIF instead (silent, loops, stops at 20 seconds - good for "click here, then here")</label>
      <label class="check"><input type="checkbox" id="useprompt"> Teleprompter (camera mode): scrolls your script while you talk</label>
      <div id="promptbox" hidden>
        <textarea id="script" rows="4" placeholder="Paste or type what you want to say..."></textarea>
        <label>Scroll speed</label><input type="range" id="speed" min="1" max="10" value="4">
      </div>
      <p class="small muted">Tip: in Screen modes Chrome asks what to share. Pick "Entire screen" or a window to show anything; pick a tab to include that tab's sound.</p>
    </div>`;

  let mode = "camera";
  let camStream = null, screenStream = null, outStream = null, recorder = null;
  let videoId = null, seq = 0, queue = Promise.resolve(), chunks = [];
  let started = 0, pausedTotal = 0, pausedAt = 0, ticker = null, clockInt = null, audioCtx = null;
  let recog = null, cues = [], lastCueEnd = 0, recording = false, promptInt = null, asGif = false;

  const elapsed = () => (recording ? ((pausedAt || Date.now()) - started - pausedTotal) / 1000 : 0);

  async function openCamera() {
    stopTracks(camStream);
    camStream = await navigator.mediaDevices.getUserMedia({
      video: $("#cam").value ? { deviceId: { exact: $("#cam").value }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { deviceId: $("#mic").value ? { exact: $("#mic").value } : undefined, echoCancellation: true, noiseSuppression: true },
    });
    // Now that permission is granted, device names are available.
    if (!$("#cam").options.length || !$("#cam").options[0].text || $("#cam").options[0].text.startsWith("Camera ")) refillDevices();
    return camStream;
  }
  async function refillDevices() {
    const ds = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, label) => {
      const cur = sel.value;
      sel.innerHTML = ds.filter((d) => d.kind === kind).map((d, i) => `<option value="${d.deviceId}">${esc(d.label || label + " " + (i + 1))}</option>`).join("");
      if (cur) sel.value = cur;
    };
    fill($("#cam"), "videoinput", "Camera"); fill($("#mic"), "audioinput", "Microphone");
  }
  function stopTracks(s) { if (s) s.getTracks().forEach((t) => t.stop()); }

  let blurred = null;
  async function applyBlur(cam) {
    if (blurred) { blurred.stopBlur(); blurred = null; }
    if (!$("#blur").checked) return cam;
    $("#blurstat").textContent = "(getting ready...)";
    try { blurred = await blurStream(cam); $("#blurstat").textContent = ""; return blurred; }
    catch (e) { $("#blurstat").textContent = "(not available on this computer)"; $("#blur").checked = false; return cam; }
  }

  async function showPreview() {
    $("#hint").hidden = true;
    if (mode === "camera") {
      try { $("#preview").srcObject = await applyBlur(await openCamera()); }
      catch (e) { $("#hint").hidden = false; $("#hint").textContent = "Allow camera and microphone access in the address bar, then click Camera again."; }
    } else {
      if (blurred) { blurred.stopBlur(); blurred = null; }
      stopTracks(camStream); camStream = null;
      $("#preview").srcObject = null;
      $("#hint").hidden = false;
      $("#hint").textContent = mode === "both"
        ? "Press Start recording, then choose what to share. Your camera appears in a circle in the corner."
        : "Press Start recording, then choose what to share.";
    }
  }

  $$(".mode").forEach((b) => b.onclick = () => {
    if (recording) return;
    $$(".mode").forEach((x) => x.classList.toggle("on", x === b));
    mode = b.dataset.mode;
    showPreview();
  });
  $("#cam").onchange = showPreview;
  $("#mic").onchange = showPreview;
  $("#blur").onchange = () => { if (mode === "camera") showPreview(); };
  $("#useprompt").onchange = () => { $("#promptbox").hidden = !$("#useprompt").checked; };

  // Mix microphone with any sound from the shared screen or tab.
  function mixAudio(streams) {
    const tracks = streams.flatMap((s) => (s ? s.getAudioTracks() : []));
    if (tracks.length <= 1) return tracks;
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    tracks.forEach((t) => audioCtx.createMediaStreamSource(new MediaStream([t])).connect(dest));
    return dest.stream.getAudioTracks();
  }

  // Screen + camera: draw both onto one canvas. A worker drives the drawing
  // so it keeps going when you switch to another tab or app.
  function composite(screen, cam) {
    const sv = document.createElement("video"); sv.srcObject = screen; sv.muted = true; sv.play();
    const cv = document.createElement("video"); cv.srcObject = cam; cv.muted = true; cv.play();
    const settings = screen.getVideoTracks()[0].getSettings();
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(1920, settings.width || 1920);
    canvas.height = Math.round(canvas.width * ((settings.height || 1080) / (settings.width || 1920)));
    const ctx = canvas.getContext("2d");
    const worker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 33)"], { type: "text/javascript" })));
    worker.onmessage = () => {
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (sv.videoWidth) ctx.drawImage(sv, 0, 0, canvas.width, canvas.height);
      if (cv.videoWidth) {
        const d = Math.round(canvas.height * 0.26), m = Math.round(canvas.height * 0.04);
        const x = m, y = canvas.height - d - m;
        const side = Math.min(cv.videoWidth, cv.videoHeight);
        ctx.save();
        ctx.beginPath(); ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        ctx.drawImage(cv, (cv.videoWidth - side) / 2, (cv.videoHeight - side) / 2, side, side, x, y, d, d);
        ctx.restore();
        ctx.lineWidth = Math.max(3, d * 0.025); ctx.strokeStyle = "#fff";
        ctx.beginPath(); ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); ctx.stroke();
      }
    };
    ticker = worker;
    return canvas.captureStream(30);
  }

  async function buildStream() {
    if (mode === "camera") {
      if (!camStream) await showPreview();
      const video = blurred ? blurred.getVideoTracks() : camStream.getVideoTracks();
      return new MediaStream([...video, ...camStream.getAudioTracks()]);
    }
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true,
      selfBrowserSurface: "exclude", surfaceSwitching: "include", systemAudio: "include",
    });
    // Stopping the share from Chrome's own bar ends the recording cleanly.
    screenStream.getVideoTracks()[0].addEventListener("ended", () => { if (recording) stop(); });
    const cam = await openCamera();
    if (mode === "screen") {
      $("#preview").srcObject = screenStream;
      return new MediaStream([...screenStream.getVideoTracks(), ...mixAudio([cam, screenStream])]);
    }
    const canvasStream = composite(screenStream, await applyBlur(cam));
    $("#preview").srcObject = canvasStream;
    return new MediaStream([...canvasStream.getVideoTracks(), ...mixAudio([cam, screenStream])]);
  }

  function startSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    recog = new SR();
    recog.continuous = true; recog.interimResults = false; recog.lang = "en-US";
    recog.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (!ev.results[i].isFinal) continue;
        const text = ev.results[i][0].transcript.trim();
        if (!text) continue;
        const end = elapsed();
        const start = Math.max(lastCueEnd, end - Math.max(1.5, text.split(/\s+/).length * 0.42));
        cues.push({ start, end: Math.max(end, start + 1), text });
        lastCueEnd = end;
      }
    };
    recog.onend = () => { if (recording && recorder?.state === "recording") { try { recog.start(); } catch (e) {} } };
    try { recog.start(); } catch (e) {}
  }

  function vtt() {
    const ts = (s) => { const d = new Date(Math.max(0, s) * 1000); return d.toISOString().substr(11, 12); };
    return "WEBVTT\n\n" + cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n");
  }

  async function countdown() {
    const el = $("#count"); el.hidden = false;
    for (const n of [3, 2, 1]) { el.textContent = n; await new Promise((r) => setTimeout(r, 800)); }
    el.hidden = true;
  }

  async function begin() {
    $("#go").disabled = true;
    try { outStream = await buildStream(); }
    catch (e) { $("#go").disabled = false; toast(e.name === "NotAllowedError" ? "Sharing was cancelled." : "Couldn't start: " + e.message); return; }
    await countdown();
    asGif = $("#asgif").checked;
    // A GIF is made on this computer after recording, so nothing uploads while recording.
    if (!asGif) {
      const created = await api("POST", "/api/videos", { mime: SS.pickMime(), folder: $("#rfolder").value });
      videoId = created.id;
    }
    seq = 0; chunks = []; cues = []; lastCueEnd = 0;
    recorder = new MediaRecorder(outStream, { mimeType: SS.pickMime(), videoBitsPerSecond: mode === "camera" ? 2500000 : 3500000 });
    recorder.ondataavailable = (ev) => {
      if (!ev.data.size) return;
      chunks.push(ev.data);
      if (asGif) return;
      const n = seq++, id = videoId, data = ev.data;
      // Upload while recording, so the link is ready the moment you stop.
      queue = queue.then(() => SS.uploadInPieces(data, () => `/api/videos/${id}/chunk?seq=${n}`, null)).catch((e) => { queue.failed = e; });
    };
    recorder.start(2000);
    recording = true; started = Date.now(); pausedTotal = 0; pausedAt = 0;
    $("#controls").hidden = true; $("#live").hidden = false; $("#opts").hidden = true;
    $$(".mode").forEach((b) => (b.disabled = true));
    clockInt = setInterval(() => {
      $("#clock").textContent = SS.fmtTime(elapsed()) + (asGif ? " / 0:20" : "");
      if (asGif && elapsed() >= 20) stop();
    }, 300);
    if (!asGif) startSpeech();
    if (mode === "camera" && $("#useprompt").checked && $("#script").value.trim()) startPrompter();
  }

  function startPrompter() {
    const box = $("#prompter"), text = $("#ptext");
    text.textContent = $("#script").value; box.hidden = false; box.scrollTop = 0;
    let pos = 0;
    promptInt = setInterval(() => {
      if (recorder?.state !== "recording") return;
      pos += Number($("#speed").value) * 0.25; box.scrollTop = pos;
    }, 33);
  }

  $("#pause").onclick = () => {
    if (recorder.state === "recording") {
      recorder.pause(); pausedAt = Date.now(); try { recog?.stop(); } catch (e) {}
      $("#pause").innerHTML = "&#9654; Resume";
    } else {
      recorder.resume(); pausedTotal += Date.now() - pausedAt; pausedAt = 0; try { recog?.start(); } catch (e) {}
      $("#pause").innerHTML = "&#10073;&#10073; Pause";
    }
  };

  function teardown() {
    recording = false;
    clearInterval(clockInt); clearInterval(promptInt);
    try { recog?.abort(); } catch (e) {}
    if (ticker) { ticker.terminate(); ticker = null; }
    stopTracks(screenStream); stopTracks(camStream); screenStream = camStream = null;
    if (blurred) { blurred.stopBlur(); blurred = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if ($("#prompter")) $("#prompter").hidden = true;
  }

  $("#restart").onclick = async () => {
    if (!confirm("Throw this take away and start over?")) return;
    const old = videoId;
    recorder.onstop = null; recorder.ondataavailable = null; recorder.stop();
    teardown();
    await queue.catch(() => {});
    if (old) api("DELETE", "/api/videos/" + old).catch(() => {});
    renderRecord();
  };

  async function stop() {
    if (!recorder || recorder.state === "inactive") return;
    const duration = elapsed();
    const stopped = new Promise((r) => { recorder.onstop = r; });
    recorder.stop();
    await stopped;
    teardown();
    if (asGif) { await finishGif(duration); return; }
    $("#live").innerHTML = `<p class="muted">Finishing up... (making captions and the email preview)</p>`;
    await queue;
    if (queue.failed) { $("#live").innerHTML = `<p class="err">Upload failed: ${esc(queue.failed.message)}. Check the internet connection.</p>`; return; }
    const transcript = cues.map((c) => c.text).join(" ");
    await api("POST", `/api/videos/${videoId}/finish`, { duration, transcript, captions: cues.length ? vtt() : "" });
    const blob = new Blob(chunks, { type: SS.pickMime().split(";")[0] });
    const tmp = document.createElement("video"); tmp.muted = true;
    try { await SS.loadBlob(tmp, blob); await makePreviews(videoId, tmp, 0); } catch (e) { console.warn("preview failed", e); }
    const replaceId = params.get("replace");
    if (replaceId) {
      await api("POST", `/api/videos/${replaceId}/replace-with/${videoId}`);
      toast("Video replaced - every link already sent now shows the new take", 4000);
      location.hash = "#/video/" + replaceId; return;
    }
    location.hash = sessionStorage.getItem("pick") ? "#/pick?made=" + videoId : "#/video/" + videoId;
  }
  // Turn the recording into a looping GIF: 8 pictures a second, up to 800 wide.
  async function finishGif(duration) {
    const live = $("#live");
    live.innerHTML = `<p class="muted" id="gifstat">Making the GIF...</p>`;
    try {
      const src = document.createElement("video"); src.muted = true;
      const len = Math.min(20, (await SS.loadBlob(src, new Blob(chunks, { type: SS.pickMime().split(";")[0] }))) || duration);
      const W = Math.min(800, src.videoWidth || 800), H = Math.round(W * (src.videoHeight / src.videoWidth || 0.5625));
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      const gif = GIFEncoder();
      const frames = Math.max(1, Math.floor(len * 8));
      for (let i = 0; i < frames; i++) {
        await SS.seek(src, Math.min(i / 8, len - 0.05));
        ctx.drawImage(src, 0, 0, W, H);
        const { data } = ctx.getImageData(0, 0, W, H);
        const palette = quantize(data, 256);
        gif.writeFrame(applyPalette(data, palette), W, H, { palette, delay: 125, repeat: i === 0 ? 0 : undefined });
        $("#gifstat").textContent = `Making the GIF... ${Math.round(((i + 1) / frames) * 100)}%`;
      }
      gif.finish();
      const blob = new Blob([gif.bytes()], { type: "image/gif" });
      const title = "GIF " + new Date().toLocaleString();
      const { id } = await api("POST", "/api/videos", { mime: "image/gif", title, folder: $("#rfolder").value || "Screenshots" });
      await SS.uploadInPieces(blob, (seq) => `/api/videos/${id}/chunk?seq=${seq}`, null);
      await api("POST", `/api/videos/${id}/finish`, { title, duration: len });
      await SS.seek(src, 0);
      const thumb = await SS.frameToJpeg(src);
      await fetch(`/api/videos/${id}/thumb`, { method: "PUT", body: thumb, credentials: "same-origin" });
      location.hash = "#/video/" + id;
    } catch (e) { live.innerHTML = `<p class="err">Couldn't make the GIF: ${esc(e.message)}</p>`; }
  }
  $("#stop").onclick = stop;
  $("#go").onclick = begin;
  window.__stopRecorder = () => { if (recording) { recorder.onstop = null; recorder.stop(); } teardown(); stopTracks(camStream); window.__stopRecorder = null; };
  // Opened from the Chrome toolbar button with a mode already chosen.
  const want = params.get("mode");
  const btn = want && $(`.mode[data-mode="${want}"]`);
  if (btn && !btn.disabled) btn.click(); else showPreview();
}

// ------------------------------------------------------------------ one video

async function renderVideo(id) {
  const v = await api("GET", "/api/videos/" + id);
  const folders = await api("GET", "/api/folders");
  const viewersRows = v.shares.filter((s) => s.channel !== "qr" || s.plays).map((s) => `
    <tr><td><b>${esc(s.recipient_name || s.recipient_email || s.recipient_phone || (s.channel === "email" ? "Email" : "Link"))}</b>
      <a href="#" class="small" data-nameshare="${s.token}" data-current="${esc(s.recipient_name)}">${s.recipient_name ? "rename" : "add a name"}</a>
      <div class="small muted">${esc(s.recipient_email || s.recipient_phone || s.channel)}</div></td>
      <td>${s.opens}</td><td>${s.plays}</td><td>${s.plays ? s.best_percent + "%" : "-"}</td>
      <td class="small">${s.last ? ago(s.last) : "not yet"}</td></tr>`).join("");
  const maxR = Math.max(1, ...v.rewatch);
  const exp = v.expires_at ? new Date(v.expires_at * 1000).toISOString().slice(0, 10) : "";
  const pub = v.publish_at ? new Date(v.publish_at * 1000).toISOString().slice(0, 10) : "";
  const T = v.totals || { views: 0, unique: 0, avg_percent: 0, still_watching: [], devices: {} };
  const locked = v.needs_manager;
  const approvalBar = !locked ? "" : me.role === "admin"
    ? `<div class="card warnbar"><b>${esc(v.owner_name)} needs this video approved before it can be sent.</b>
        <div class="row" style="margin-top:8px"><button class="btn primary" id="appr-yes">&#10004; Approve</button>
        <button class="btn" id="appr-no">Send back with a note</button></div></div>`
    : `<div class="card warnbar"><b>${v.approval === "pending" ? "Waiting for your manager to approve this video." : "Your manager checks videos before they go out."}</b>
        ${v.approval === "pending" ? "" : `<div class="row" style="margin-top:8px"><button class="btn primary" id="appr-ask">Ask for approval</button></div>`}</div>`;
  view.innerHTML = `
    <div class="row spread"><a href="#/" class="muted">&larr; Library</a>
      ${v.received_from ? `<span class="pill">Recorded by ${esc(v.received_from)}</span>` : ""}
      ${v.received_from && v.consent ? `<span class="pill">OK to share publicly</span>` : ""}</div>
    ${approvalBar}
    <div class="detail" style="margin-top:12px">
      <div>
        <div class="card">
          <input id="title" value="${esc(v.title)}" style="font-size:20px;font-weight:700;border-color:transparent;padding:4px 6px;margin:-4px 0 10px -6px">
          ${v.kind === "image" ? `
          <a href="/api/videos/${v.id}/file${SS.mk()}" target="_blank" title="Open full size"><img class="shot" src="/api/videos/${v.id}/file?t=${Date.now()}${SS.mk("&")}" alt=""></a>
          <div class="trimbar">
            ${v.mime !== "image/gif" ? `<a class="btn primary" href="#/edit/${v.id}">&#9998; Edit / mark up</a>` : ""}
            <a class="btn" href="/api/videos/${v.id}/file${SS.mk()}" download="${esc(v.title || "screenshot")}">&#11015; Download</a>
            ${v.source_url ? `<a class="small muted" href="${esc(v.source_url)}" target="_blank" rel="noopener">Taken from ${esc(v.source_url.slice(0, 60))}</a>` : ""}
          </div>` : `
          <video id="pv" controls playsinline preload="metadata" src="/api/videos/${v.id}/file${SS.mk()}" poster="/api/videos/${v.id}/thumb.jpg${SS.mk()}"></video>
          <div class="trimbar">
            <button class="btn" id="setstart">&#9986; Start here</button>
            <button class="btn" id="setend">&#9986; End here</button>
            <button class="btn" id="cleartrim">Clear trim</button>
            <span class="small muted" id="triminfo"></span>
          </div>
          <div class="trimbar">
            <button class="btn" id="cuta">&#9986; Cut out from here...</button>
            <button class="btn" id="cutb" disabled>...to here</button>
            <button class="btn" id="silence">&#128263; Remove long pauses</button>
          </div>
          <div class="small" id="skiplist"></div>
          <div class="trimbar"><button class="btn" id="usethumb">&#128444; Use this moment as the preview picture</button></div>`}
          ${v.transcript ? `<details style="margin-top:12px"><summary class="muted">${v.received_from ? "Their note" : v.kind === "image" ? "Text in this picture" : "What was said (captions)"}</summary><p>${esc(v.transcript)}</p></details>` : ""}
        </div>
        <div class="card">
          <h2>Settings</h2>
          <div class="grid2">
            <div><label>Folder</label><select id="vfolder"><option value="">No folder</option>${[...new Set([...folders, v.folder, "Received"].filter(Boolean))].map((f) => `<option ${f === v.folder ? "selected" : ""}>${esc(f)}</option>`).join("")}<option value="__new">+ New folder...</option></select></div>
            <div><label>Expires on (optional)</label><input type="date" id="vexp" value="${exp}"></div>
            <div><label>Can't be watched before (optional)</label><input type="date" id="vpub" value="${pub}"></div>
            <div></div>
            <div><label>Button text (optional)</label><input id="ctal" value="${esc(v.cta_label)}" placeholder="e.g. Book a call"></div>
            <div><label>Button link</label><input id="ctau" value="${esc(v.cta_url)}" placeholder="https://..."></div>
            <div><label>Password (optional)</label><input id="vpw" placeholder="${v.has_password ? "Password set - type to change" : "No password"}" autocomplete="new-password"></div>
            <div style="align-self:end">${v.has_password ? `<button class="btn" id="clearpw">Remove password</button>` : ""}</div>
            <div><label>"Watched and agree" button (optional)</label><input id="vconf" value="${esc(v.confirm_label)}" placeholder="e.g. I've watched the house rules and agree"></div>
            <div><label>Show this only after they agree (optional)</label><input id="vreveal" value="${esc(v.reveal_text)}" placeholder="e.g. Your door code is 4821"></div>
          </div>
          <label class="check"><input type="checkbox" id="vappr" ${v.approve_buttons ? "checked" : ""}> Add Approve / Decline buttons (e.g. an owner approving a repair)</label>
          ${v.kind === "video" && v.captions ? `<label class="check"><input type="checkbox" id="vread" ${v.show_transcript ? "checked" : ""}> Show the "read along" text (what was said) under the video</label>` : ""}
          <label class="check"><input type="checkbox" id="vonce" ${v.view_once ? "checked" : ""}> View once: each link stops working after that person has watched it</label>
          <div class="row" style="margin-top:14px"><button class="btn primary" id="save">Save settings</button>
            <button class="btn" id="replace">&#8635; Replace ${v.kind === "image" ? "picture" : "video"} (same links)</button>
            <button class="btn" id="toplaylist">&#9776; Add to a playlist</button>
            <button class="btn danger" id="del" style="margin-left:auto">Delete</button></div>
        </div>
        ${v.kind === "video" ? `<div class="card"><h2>Chapters</h2>
          <p class="small muted" style="margin-top:0">Let people jump straight to a part, like "Hot tub" or "Checkout".</p>
          <div id="chaplist"></div>
          <div class="row" style="margin-top:8px"><button class="btn" id="chapadd">+ Add a chapter where the video is now</button>
          ${v.captions ? `<button class="btn" id="chapsuggest">&#10024; Suggest chapters from what was said</button>` : ""}</div>
        </div>` : ""}
        <div class="card"><h2>Questions, polls and ratings</h2>
          <p class="small muted" style="margin-top:0">Ask viewers something. You're alerted with every answer.</p>
          <div id="qlist"></div>
          <div class="row" style="margin-top:8px"><button class="btn" id="qadd">+ Add a question</button>
            <button class="btn" id="qrate">&#11088; Add "Rate your stay" (1-5 stars)</button></div>
        </div>
      </div>
      <div>
        <div class="card">
          <h2>Send it</h2>
          <div class="sendgrid" ${locked ? 'style="opacity:.45;pointer-events:none"' : ""}>
            <button class="btn primary" id="s-email">&#9993; Copy for email</button>
            <button class="btn primary" id="s-text">&#128172; Text it</button>
            <button class="btn" id="s-link">&#128279; Copy link</button>
            <button class="btn" id="s-share">&#8679; Share...</button>
            <button class="btn" id="s-qr">&#9638; QR code</button>
            <button class="btn" id="s-embed">&lt;/&gt; Put on a website</button>
          </div>
          <p class="small muted" style="margin:10px 0 0">One click copies it. Then click in your email and press Ctrl+V. Every copy gets its own tracking link.</p>
        </div>
        <div class="card">
          <div class="row spread"><h2 style="margin:0">Who watched</h2>
            <span class="small muted">${v.opens} opens &middot; ${v.plays} views &middot; ${v.viewers} people</span></div>
          ${viewersRows ? `<table class="list" style="margin-top:8px"><tr><th>Person</th><th>Opens</th><th>Views</th><th>Most watched</th><th>Last</th></tr>${viewersRows}</table>` : `<p class="muted">Not sent yet.</p>`}
        </div>
        <div class="card">
          <h2>Totals</h2>
          <div class="tiles4"><div><b>${T.views}</b><span>views</span></div><div><b>${T.unique}</b><span>people</span></div>
            ${v.kind === "video" ? `<div><b>${T.avg_percent}%</b><span>watched on average</span></div>` : ""}
            <div><b>${Object.entries(T.devices).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ") || "-"}</b><span>devices</span></div></div>
          ${v.kind === "video" && T.views ? `
          <h3 class="small muted" style="margin:14px 0 4px">Still watching (where people stop)</h3>
          <div class="rewatch">${T.still_watching.map((n) => `<div style="height:${n}%" title="${n}% still watching"></div>`).join("")}</div>
          <div class="rewatch-axis"><span>start</span><span>middle</span><span>end</span></div>
          <h3 class="small muted" style="margin:14px 0 4px">Watched again (most replayed parts)</h3>
          <div class="rewatch">${v.rewatch.map((n) => `<div style="height:${Math.round((n / maxR) * 100)}%;background:#f77f00" title="${n} views"></div>`).join("")}</div>` : ""}
        </div>
        <div class="card">
          <h2>Activity</h2>
          <ul class="feed">${v.events.slice(0, 50).map(feedItem).join("") || `<li class="muted">Nothing yet.</li>`}</ul>
        </div>
      </div>
    </div>`;

  if (v.kind === "video") bindVideoTools();
  function bindVideoTools() {
  const pv = $("#pv");
  let trim = { start: v.trim_start, end: v.trim_end };
  const showTrim = () => {
    $("#triminfo").textContent = trim.start || trim.end
      ? `Plays from ${SS.fmtTime(trim.start)} to ${trim.end ? SS.fmtTime(trim.end) : "the end"}` : "";
  };
  showTrim();
  const saveTrim = async () => {
    await api("PATCH", "/api/videos/" + id, { trim_start: trim.start, trim_end: trim.end }); showTrim(); toast("Trim saved");
  };
  $("#setstart").onclick = async () => {
    trim.start = pv.currentTime; await saveTrim();
    toast("Trim saved. Updating the email preview..."); await refreshPreview(trim.start);
  };
  $("#setend").onclick = () => { trim.end = pv.currentTime; saveTrim(); };
  $("#cleartrim").onclick = () => { trim = { start: 0, end: 0 }; saveTrim(); };
  $("#usethumb").onclick = () => refreshPreview(pv.currentTime);

  // ---- cutting out sections (nothing is re-encoded: the player jumps over them)
  let skips = v.skips || [];
  let cutFrom = null;
  const showSkips = () => {
    const total = skips.reduce((a, [s, e]) => a + (e - s), 0);
    $("#skiplist").innerHTML = skips.length
      ? `Cut out (${SS.fmtTime(total)} total): ` + skips.map(([a, b], i) =>
        `<span class="pill" style="margin:2px">${SS.fmtTime(a)}&ndash;${SS.fmtTime(b)} <a href="#" data-unskip="${i}" title="Put back">&times;</a></span>`).join("")
        + ` <a href="#" id="unskipall">put everything back</a>`
      : "";
    $$("[data-unskip]").forEach((a) => a.onclick = (e) => { e.preventDefault(); skips.splice(+a.dataset.unskip, 1); saveSkips(); });
    if ($("#unskipall")) $("#unskipall").onclick = (e) => { e.preventDefault(); skips = []; saveSkips(); };
  };
  const saveSkips = async (msg) => {
    const r = await api("PATCH", "/api/videos/" + id, { skips });
    skips = r.skips; showSkips(); if (msg) toast(msg);
  };
  showSkips();
  $("#cuta").onclick = () => {
    cutFrom = pv.currentTime; $("#cutb").disabled = false;
    toast(`Cut starts at ${SS.fmtTime(cutFrom)}. Now play or drag to where it should end, then press "...to here".`, 4500);
  };
  $("#cutb").onclick = () => {
    const to = pv.currentTime;
    if (cutFrom === null || to <= cutFrom + 0.2) { toast("Move past the start of the cut first"); return; }
    skips.push([cutFrom, to]); cutFrom = null; $("#cutb").disabled = true;
    saveSkips("Section cut out");
  };
  // Long pauses: listen to the sound track and cut any quiet stretch over 1.2 seconds.
  $("#silence").onclick = async () => {
    $("#silence").disabled = true; $("#silence").textContent = "Listening for pauses...";
    try {
      const buf = await (await fetch(`/api/videos/${id}/file`, { credentials: "same-origin" })).arrayBuffer();
      const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
      const audio = await ctx.decodeAudioData(buf);
      const data = audio.getChannelData(0), rate = audio.sampleRate, win = Math.round(rate * 0.05);
      const levels = [];
      for (let i = 0; i < data.length; i += win) {
        let sum = 0; const end = Math.min(data.length, i + win);
        for (let j = i; j < end; j++) sum += data[j] * data[j];
        levels.push(Math.sqrt(sum / (end - i)));
      }
      const sorted = [...levels].sort((a, b) => a - b);
      const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
      const speech = sorted[Math.floor(sorted.length * 0.9)] || 0.05;
      const quiet = Math.max(floor * 2, speech * 0.08, 0.003);
      const found = [];
      let startQ = null;
      levels.forEach((lvl, i) => {
        const t = i * 0.05;
        if (lvl < quiet) { if (startQ === null) startQ = t; }
        else { if (startQ !== null && t - startQ >= 1.2) found.push([startQ + 0.35, t - 0.35]); startQ = null; }
      });
      if (!found.length) { toast("No long pauses found"); return; }
      const saved = found.reduce((a, [s, e]) => a + e - s, 0);
      skips = skips.concat(found);
      await saveSkips(`Removed ${found.length} pause${found.length === 1 ? "" : "s"} (${Math.round(saved)} seconds shorter)`);
    } catch (e) { toast("Couldn't read the sound: " + e.message); }
    finally { $("#silence").disabled = false; $("#silence").innerHTML = "&#128263; Remove long pauses"; }
  };
  // Preview the cuts in this player too.
  pv.addEventListener("timeupdate", () => {
    for (const [a, b] of skips) if (pv.currentTime >= a && pv.currentTime < b - 0.05 && cutFrom === null && !pv.paused) { pv.currentTime = b; break; }
  });

  } // end of video-only tools

  // ---- manager approval
  if ($("#appr-ask")) $("#appr-ask").onclick = async () => { await api("POST", `/api/videos/${id}/submit`); toast("Sent to your manager for approval"); renderVideo(id); };
  if ($("#appr-yes")) $("#appr-yes").onclick = async () => { await api("POST", `/api/videos/${id}/approve`, { approve: true }); toast("Approved"); renderVideo(id); };
  if ($("#appr-no")) $("#appr-no").onclick = async () => {
    const note = prompt("What should they change?") ;
    if (note === null) return;
    await api("POST", `/api/videos/${id}/approve`, { approve: false, note }); toast("Sent back"); renderVideo(id);
  };

  async function refreshPreview(at) {
    const tmp = document.createElement("video"); tmp.muted = true; tmp.crossOrigin = "use-credentials";
    tmp.src = `/api/videos/${id}/file${SS.mk()}`;
    await new Promise((r) => { tmp.onloadeddata = r; });
    if (!isFinite(tmp.duration)) { await SS.seek(tmp, 1e7); }
    await makePreviews(id, tmp, Math.max(0, at - 0.5));
    $("#pv").poster = `/api/videos/${id}/thumb.jpg?t=` + Date.now() + SS.mk("&");
    toast("Preview picture updated");
  }

  $("#title").onchange = async () => { await api("PATCH", "/api/videos/" + id, { title: $("#title").value }); toast("Title saved"); };
  $("#vfolder").onchange = async () => {
    let f = $("#vfolder").value;
    if (f === "__new") { f = (prompt("Folder name:") || "").trim(); if (!f) { $("#vfolder").value = v.folder; return; } }
    await api("PATCH", "/api/videos/" + id, { folder: f }); toast("Moved to " + (f || "no folder")); renderVideo(id);
  };
  $("#save").onclick = async () => {
    const body = { cta_label: $("#ctal").value, cta_url: $("#ctau").value,
      confirm_label: $("#vconf").value, reveal_text: $("#vreveal").value,
      approve_buttons: $("#vappr").checked, view_once: $("#vonce").checked,
      ...($("#vread") ? { show_transcript: $("#vread").checked } : {}),
      expires_at: $("#vexp").value ? new Date($("#vexp").value + "T23:59:59").getTime() / 1000 : null,
      publish_at: $("#vpub").value ? new Date($("#vpub").value + "T00:00:00").getTime() / 1000 : null };
    if ($("#vpw").value) body.password = $("#vpw").value;
    await api("PATCH", "/api/videos/" + id, body); toast("Saved"); renderVideo(id);
  };
  if ($("#clearpw")) $("#clearpw").onclick = async () => { await api("PATCH", "/api/videos/" + id, { password: "" }); toast("Password removed"); renderVideo(id); };
  $("#del").onclick = async () => {
    if (!confirm("Delete this video for good? Links already sent will stop working.")) return;
    await api("DELETE", "/api/videos/" + id); location.hash = "#/";
  };

  // ---- sending
  // One click: the email preview is copied, ready to paste into the email you're writing.
  // Nothing to fill in. (Name a viewer afterwards under "Who watched" if you like.)
  const newShare = (channel) => api("POST", `/api/videos/${id}/shares`, { channel });
  const copyLater = async (makeHtml, makeText) => {
    // Hand the clipboard a "promise" so the copy still counts as part of the click.
    const html = makeHtml(), text = makeText();
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": html.then((h) => new Blob([h], { type: "text/html" })),
        "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })),
      })]);
      return true;
    } catch (e) { await copyText(await text); return false; }
  };
  $("#s-email").onclick = async () => {
    const share = newShare("email");
    const ok = await copyLater(() => share.then((sh) => sh.html), () => share.then((sh) => sh.url));
    toast(ok ? "Copied - click in your Gmail email and press Ctrl+V" : "Link copied - paste it into your email", 5000);
  };
  $("#s-text").onclick = async () => {
    const share = newShare("text");
    const msg = share.then((sh) => `Here's a quick video for you: ${sh.url}`);
    if (navigator.share && /Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) {
      navigator.share({ text: await msg }).catch(() => {}); // pick the person in Messages
    } else { await copyLater(() => msg, () => msg); toast("Message copied - paste it into your text"); }
  };
  $("#s-link").onclick = async () => {
    const share = newShare("link");
    await copyLater(() => share.then((sh) => sh.url), () => share.then((sh) => sh.url));
    toast("Link copied");
  };
  $("#s-share").onclick = async () => {
    const sh = await newShare("text");
    if (navigator.share) navigator.share({ title: v.title, text: "Here's a quick video for you:", url: sh.url }).catch(() => {});
    else { await copyText(sh.url); toast("Link copied (sharing isn't available on this computer)"); }
  };
  // Name a viewer after the fact (e.g. "Jordan"), so alerts and this list say who it was.
  $$("[data-nameshare]").forEach((a) => a.onclick = async (e) => {
    e.preventDefault();
    const name = prompt("Who was this sent to? (just for your records)", a.dataset.current || "");
    if (name === null) return;
    await api("PATCH", "/api/shares/" + a.dataset.nameshare, { recipient_name: name });
    renderVideo(id);
  });
  // ---- replace the video, keep every link
  $("#replace").onclick = () => {
    const card = modal(`<h2>Replace this ${v.kind === "image" ? "picture" : "video"}</h2>
      <p class="muted">Everyone you already sent it to will see the new one. Views and replies so far are kept.</p>
      <div class="sendgrid" style="grid-template-columns:1fr">
        ${v.kind === "video" ? `<a class="btn primary" href="#/record?replace=${id}" id="rp-rec">&#9679; Record a new take</a>` : ""}
        <label class="btn">&#8679; Upload a file instead<input type="file" id="rp-file" accept="${v.kind === "image" ? "image/*" : "video/*"}" hidden></label>
      </div><div class="row" style="margin-top:10px"><button class="btn" id="rp-x">Cancel</button></div>`);
    if ($("#rp-rec", card)) $("#rp-rec", card).onclick = () => closeModal();
    $("#rp-x", card).onclick = closeModal;
    $("#rp-file", card).onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (v.kind === "image") {
        const { id: nid } = await api("POST", "/api/videos", { mime: f.type, title: v.title });
        await SS.uploadInPieces(f, (seq) => `/api/videos/${nid}/chunk?seq=${seq}`, null);
        await api("POST", `/api/videos/${nid}/finish`, { title: v.title });
        await api("POST", `/api/videos/${id}/replace-with/${nid}`);
        closeModal(); toast("Picture replaced"); location.hash = "#/edit/" + id;
      } else { closeModal(); uploadExisting(f, id); }
    };
  };

  // ---- playlists
  $("#toplaylist").onclick = async () => {
    const lists = await api("GET", "/api/playlists");
    const card = modal(`<h2>Add to a playlist</h2>
      ${lists.length ? `<div class="sendgrid" style="grid-template-columns:1fr">${lists.map((p) => `<button class="btn" data-pl="${p.id}">${esc(p.title)} <span class="small muted">(${p.items.length})</span></button>`).join("")}</div>` : `<p class="muted">No playlists yet.</p>`}
      <label>Or start a new one</label><div class="row"><input id="plnew" placeholder="e.g. Lake House - guest guide" style="flex:1"><button class="btn primary" id="plmk">Create</button></div>
      <div class="row" style="margin-top:10px"><button class="btn" id="plx">Close</button></div>`);
    const add = async (p) => {
      const ids = p.items.map((i) => i.id).filter((x) => x !== id).concat([id]);
      await api("PATCH", "/api/playlists/" + p.id, { videos: ids });
      closeModal(); toast(`Added to "${p.title}"`);
    };
    $$("[data-pl]", card).forEach((b) => b.onclick = () => add(lists.find((p) => p.id === b.dataset.pl)));
    $("#plmk", card).onclick = async () => { const t = $("#plnew", card).value.trim(); if (t) add(await api("POST", "/api/playlists", { title: t })); };
    $("#plx", card).onclick = closeModal;
  };

  // ---- website embed
  $("#s-embed").onclick = async () => {
    const sh = await api("POST", `/api/videos/${id}/shares`, { recipient_name: "Website visitor", channel: "link" });
    const code = `<iframe src="${sh.url}?embed=1" width="640" height="420" style="max-width:100%;border:0;border-radius:12px" allow="fullscreen" allowfullscreen></iframe>`;
    const card = modal(`<h2>Put this on a website</h2>
      <p class="muted">Copy this code into your website (in an "HTML" or "embed" block). Views show up here as "Website visitor".</p>
      <textarea rows="4" readonly>${esc(code)}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="emc">Copy code</button><button class="btn" id="emx">Close</button></div>`);
    $("#emc", card).onclick = async () => { await copyText(code); toast("Code copied"); };
    $("#emx", card).onclick = closeModal;
  };

  // ---- chapters
  let chapters = v.chapters || [];
  const saveChapters = async () => { const r = await api("PATCH", "/api/videos/" + id, { chapters }); chapters = r.chapters; showChapters(); };
  function showChapters() {
    const box = $("#chaplist"); if (!box) return;
    box.innerHTML = chapters.length ? chapters.map((c, i) => `<div class="row" style="margin:4px 0">
        <button class="btn" data-go="${i}" style="min-width:64px">${SS.fmtTime(c.t)}</button>
        <input value="${esc(c.title)}" data-ct="${i}" style="flex:1"><button class="btn danger" data-cx="${i}">&times;</button></div>`).join("")
      : `<p class="small muted">No chapters yet.</p>`;
    $$("[data-go]", box).forEach((b) => b.onclick = () => { const p = $("#pv"); if (p) { p.currentTime = chapters[b.dataset.go].t; p.play(); } });
    $$("[data-ct]", box).forEach((inp) => inp.onchange = () => { chapters[inp.dataset.ct].title = inp.value; saveChapters(); });
    $$("[data-cx]", box).forEach((b) => b.onclick = () => { chapters.splice(+b.dataset.cx, 1); saveChapters(); });
  }
  showChapters();
  if ($("#chapadd")) $("#chapadd").onclick = () => {
    const t = $("#pv") ? $("#pv").currentTime : 0;
    const title = prompt(`Chapter name (starts at ${SS.fmtTime(t)}):`);
    if (title) { chapters.push({ t, title }); saveChapters(); }
  };
  // Suggest: a new chapter roughly every 45 seconds, at the start of a sentence, named from its first words.
  if ($("#chapsuggest")) $("#chapsuggest").onclick = async () => {
    const cues = [];
    v.captions.split(/\n\n+/).forEach((block) => {
      const m = block.match(/(\d+):(\d+):(\d+)[.,](\d+)\s+-->/);
      if (!m) return;
      cues.push({ t: (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]), text: block.split("\n").filter((l) => l && !l.includes("-->") && !/^\d+$/.test(l)).join(" ") });
    });
    if (!cues.length) { toast("No captions to work from"); return; }
    const out = [{ t: 0, title: "Intro" }];
    let last = 0;
    for (const c of cues) if (c.t - last >= 45) { out.push({ t: c.t, title: c.text.split(/\s+/).slice(0, 5).join(" ").replace(/[.,!?]+$/, "") }); last = c.t; }
    if (chapters.length && !confirm("Replace your current chapters with the suggested ones?")) return;
    chapters = out; await saveChapters(); toast(`Suggested ${out.length} chapters - rename any of them`);
  };

  // ---- questions, polls, ratings
  let questions = v.questions || [];
  const saveQuestions = async () => { const r = await api("PATCH", "/api/videos/" + id, { questions }); questions = r.questions; showQuestions(); };
  function showQuestions() {
    const box = $("#qlist");
    box.innerHTML = questions.length ? questions.map((q, i) => {
      const ans = (v.answers || {})[q.id] || [];
      let summary = "";
      if (q.type === "rating" && ans.length) summary = `Average ${(ans.reduce((a, x) => a + Number(x.a), 0) / ans.length).toFixed(1)} &#9733; from ${ans.length}`;
      else if (q.type === "choice" && ans.length) summary = q.options.map((o) => `${esc(o)}: ${ans.filter((x) => x.a === o).length}`).join(" &middot; ");
      else summary = ans.length ? `${ans.length} answer${ans.length === 1 ? "" : "s"}` : "No answers yet";
      return `<div class="qrow"><div><b>${esc(q.q)}</b>
          <div class="small muted">${q.type === "rating" ? "1-5 stars" : q.type === "choice" ? "Choices: " + q.options.map(esc).join(", ") : "Written answer"}
          &middot; ${q.t === null || q.t === undefined ? "after the video" : "at " + SS.fmtTime(q.t)}</div>
          <div class="small">${summary}</div>
          ${ans.length ? `<details class="small"><summary>See answers</summary>${ans.slice(0, 50).map((a) => `<div>${esc(a.who)}: <b>${q.type === "rating" ? "&#9733;".repeat(Number(a.a)) : esc(a.a)}</b> <span class="muted">${ago(a.at)}</span></div>`).join("")}</details>` : ""}
        </div><button class="btn danger" data-qx="${i}">&times;</button></div>`;
    }).join("") : `<p class="small muted">No questions yet.</p>`;
    $$("[data-qx]", box).forEach((b) => b.onclick = () => { if (confirm("Remove this question?")) { questions.splice(+b.dataset.qx, 1); saveQuestions(); } });
  }
  showQuestions();
  $("#qrate").onclick = () => { questions.push({ type: "rating", q: "How would you rate your stay?", t: null, options: [] }); saveQuestions(); toast("Added - viewers see it at the end"); };
  $("#qadd").onclick = () => {
    const now = $("#pv") ? $("#pv").currentTime : 0;
    const card = modal(`<h2>Add a question</h2>
      <label>Question</label><input id="qq" placeholder="e.g. Did you find the lockbox OK?">
      <label>Type of answer</label><select id="qt"><option value="choice">Pick from choices</option><option value="rating">1-5 stars</option><option value="text">Written answer</option></select>
      <div id="qob"><label>Choices (one per line)</label><textarea id="qo" rows="3">Yes
No</textarea></div>
      <label>When to ask</label><select id="qw"><option value="end">After the video</option>${$("#pv") ? `<option value="now">Pause at ${SS.fmtTime(now)} and ask</option>` : ""}</select>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="qok">Add</button><button class="btn" id="qx2">Cancel</button></div>`);
    $("#qt", card).onchange = () => { $("#qob", card).hidden = $("#qt", card).value !== "choice"; };
    $("#qx2", card).onclick = closeModal;
    $("#qok", card).onclick = () => {
      const q = { type: $("#qt", card).value, q: $("#qq", card).value.trim(), t: $("#qw", card).value === "now" ? now : null,
        options: $("#qo", card).value.split("\n").map((x) => x.trim()).filter(Boolean) };
      if (!q.q) { toast("Type the question"); return; }
      if (q.type === "choice" && q.options.length < 2) { toast("Add at least two choices"); return; }
      closeModal(); questions.push(q); saveQuestions();
    };
  };

  $("#s-qr").onclick = () => {
    modal(`<h2>QR code</h2><img class="qr" src="/api/videos/${id}/qr.png" alt="QR code">
      <p class="small muted">Print it on a sign in the unit or on a mailer. Every scan shows up in your activity as "QR code scan".</p>
      <div class="row"><a class="btn primary" href="/api/videos/${id}/qr.png" download="qr-${id}.png">Download</a>
      <button class="btn" id="mclose">Close</button></div>`);
    $("#mclose").onclick = closeModal;
  };
}

function chooseTextRoute(phone) {
  return new Promise((resolve) => {
    const card = modal(`<h2>Send the text from...</h2>
      <div class="sendgrid" style="grid-template-columns:1fr">
        <button class="btn primary" id="tr-biz">&#127970; The __COMPANY__ number (sends now, from here)</button>
        <button class="btn" id="tr-me">&#128241; My own phone</button>
      </div><div class="row" style="margin-top:10px"><button class="btn" id="tr-x">Cancel</button></div>`);
    $("#tr-biz", card).onclick = () => { closeModal(); resolve("business"); };
    $("#tr-me", card).onclick = () => { closeModal(); resolve("mine"); };
    $("#tr-x", card).onclick = () => { closeModal(); resolve(null); };
  });
}

// Pick who a video is for. Searches people you've sent to before.
function askRecipient({ title, want, optional }) {
  return new Promise((resolve) => {
    const card = modal(`<h2>${esc(title)}</h2>
      ${"contacts" in navigator && "select" in navigator.contacts ? `<button class="btn" id="pickc" type="button" style="width:100%;margin-bottom:6px">&#128199; Pick from my phone's contacts</button>` : ""}
      <label>Name</label><input id="rn" placeholder="Start typing a name..." autocomplete="off">
      <div class="suggest" id="sug" hidden></div>
      ${want !== "phone" ? `<label>Email</label><input id="re" type="email" placeholder="name@example.com" autocomplete="off">` : ""}
      ${want !== "email" ? `<label>Mobile number ${want === "phone" ? "(or leave blank and pick them in Messages)" : ""}</label><input id="rp" type="tel" placeholder="(404) 555-1234" autocomplete="off">` : ""}
      ${optional ? `<p class="small muted">Optional - add a name so you know who watched.</p>` : ""}
      <div class="row" style="margin-top:14px"><button class="btn primary" id="rok">Continue</button><button class="btn" id="rcancel">Cancel</button></div>`);
    const rn = $("#rn", card), sug = $("#sug", card);
    rn.focus();
    let t;
    rn.oninput = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = rn.value.trim();
        if (q.length < 2) { sug.hidden = true; return; }
        const list = await api("GET", "/api/contacts?q=" + encodeURIComponent(q));
        sug.hidden = !list.length;
        sug.innerHTML = list.map((c, i) => `<button type="button" data-i="${i}"><b>${esc(c.name || c.email || c.phone)}</b> <span class="small muted">${esc(c.email || "")} ${esc(c.phone || "")}</span></button>`).join("");
        $$("button", sug).forEach((b) => b.onclick = () => {
          const c = list[b.dataset.i];
          rn.value = c.name || "";
          if ($("#re", card) && c.email) $("#re", card).value = c.email;
          if ($("#rp", card) && c.phone) $("#rp", card).value = c.phone;
          sug.hidden = true;
        });
      }, 200);
    };
    // Android phones: open the phone's own contact list.
    if ($("#pickc", card)) $("#pickc", card).onclick = async () => {
      try {
        const [c] = await navigator.contacts.select(["name", "tel", "email"], { multiple: false });
        if (!c) return;
        rn.value = (c.name || [])[0] || "";
        if ($("#re", card) && (c.email || [])[0]) $("#re", card).value = c.email[0];
        if ($("#rp", card) && (c.tel || [])[0]) $("#rp", card).value = c.tel[0];
      } catch (e) { /* closed without picking */ }
    };
    $("#rcancel", card).onclick = () => { closeModal(); resolve(null); };
    $("#rok", card).onclick = () => {
      const out = { recipient_name: rn.value.trim(), recipient_email: $("#re", card)?.value.trim() || "", recipient_phone: $("#rp", card)?.value.trim() || "" };
      if (want === "email" && !out.recipient_name && !out.recipient_email) { rn.focus(); toast("Add a name or email so you know who watched"); return; }
      closeModal(); resolve(out);
    };
  });
}

function feedItem(e) {
  const name = esc(whoOf(e));
  const title = e.title ? ` <span class="muted">&middot; ${esc(e.title)}</span>` : "";
  const map = {
    open: e.detail === "sent"
      ? ["&#128228;", `Email sent <span class="likely">(Gmail loading your own copy - not counted as an open)</span>`]
      : ["&#9993;", `${name} opened the email${e.likely_bot ? ' <span class="likely">(probably an email scanner, not a person)</span>' : ""}`],
    play: ["&#9654;", `${name} watched${e.percent ? " " + e.percent + "%" : ""}`],
    click: ["&#128073;", `${name} clicked "${esc(e.detail)}"`],
    like: ["&#128077;", `${name} liked it`],
    comment: ["&#128172;", `${name} replied: "${esc(e.detail)}"`],
    received: ["&#127909;", `${esc(e.detail)} sent you a video`],
    confirm: ["&#9989;", `${name} confirmed: "${esc(e.detail)}"`],
    answer: ["&#10067;", (() => { try { const a = JSON.parse(e.detail); return `${name} answered "${esc(a.q)}": <b>${typeof a.a === "number" ? "&#9733;".repeat(a.a) : esc(a.a)}</b>`; } catch (x) { return `${name} answered a question`; } })()],
    approve: ["&#9989;", `<b>${name} APPROVED</b>${e.detail ? ': "' + esc(e.detail) + '"' : ""}`],
    decline: ["&#10060;", `<b>${name} DECLINED</b>${e.detail ? ': "' + esc(e.detail) + '"' : ""}`],
  };
  const [ico, text] = map[e.kind] || ["&#8226;", e.kind];
  return `<li><span class="ico">${ico}</span><div>${text}${title}${e.owner_name && me.role === "admin" ? `<div class="small muted">sent by ${esc(e.owner_name)}</div>` : ""}</div><span class="when">${ago(e.created_at)}</span></li>`;
}

// ------------------------------------------------------------------ activity

async function renderActivity() {
  const users = me.role === "admin" ? await api("GET", "/api/users") : [];
  view.innerHTML = `
    <div class="row spread"><h1>Activity</h1>
      ${users.length ? `<select id="who" style="max-width:240px"><option value="0">Everyone</option>${users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select>` : ""}</div>
    <div class="card"><ul class="feed" id="feed"></ul></div>`;
  const load = async () => {
    const list = await api("GET", "/api/activity?limit=200&user_id=" + ($("#who")?.value || 0));
    $("#feed").innerHTML = list.map((e) => feedItem(e).replace("<li>", `<li style="cursor:pointer" onclick="location.hash='#/video/${e.video_id}'">`)).join("") || `<li class="muted">Nothing yet. Send a video and opens and views show up here.</li>`;
  };
  if ($("#who")) $("#who").onchange = load;
  await load();
  pollTimer = setInterval(load, 30000);
}

// ------------------------------------------------------------------ ask for a video

async function renderRequests() {
  const list = await api("GET", "/api/requests");
  view.innerHTML = `
    <h1>Ask someone to record a video for you</h1>
    <div class="card">
      <p class="muted" style="margin-top:0">Send a link to a guest, cleaner or owner. They record on their phone (no app, no account) and the video lands in your library under "Received".</p>
      <label>What do you want them to record?</label>
      <input id="rt" placeholder="e.g. Please show us the broken dishwasher">
      <label>Extra instructions (optional)</label>
      <textarea id="rm" rows="2" placeholder="e.g. Show the model number sticker inside the door"></textarea>
      <label class="check"><input type="checkbox" id="rtest"> This is a testimonial (asks their permission to use it on the website; videos go to the Testimonials folder)</label>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="mk">Create link</button></div>
    </div>
    <div class="card"><h2>Open links</h2>
      ${list.length ? `<table class="list"><tr><th>Asking for</th><th>Created</th><th></th></tr>${list.map((r) => `
        <tr><td><b>${esc(r.title)}</b><div class="small muted">${esc(r.url)}</div></td><td class="small">${ago(r.created_at)}</td>
        <td class="row"><button class="btn" data-copy="${esc(r.url)}">Copy link</button><button class="btn" data-text="${esc(r.url)}" data-title="${esc(r.title)}">Text it</button><button class="btn danger" data-close="${r.token}">Close</button></td></tr>`).join("")}</table>`
        : `<p class="muted">No open links.</p>`}
    </div>`;
  $("#mk").onclick = async () => {
    const r = await api("POST", "/api/requests", { title: $("#rt").value, message: $("#rm").value, testimonial: $("#rtest").checked });
    await copyText(r.url); toast("Link created and copied"); renderRequests();
  };
  $$("[data-copy]").forEach((b) => b.onclick = async () => { await copyText(b.dataset.copy); toast("Link copied"); });
  $$("[data-text]").forEach((b) => b.onclick = async () => {
    const body = `${b.dataset.title} - you can record it here, no app needed: ${b.dataset.text}`;
    if (navigator.share) navigator.share({ text: body }).catch(() => {});
    else { await copyText(body); toast("Message copied - paste it into your text"); }
  });
  $$("[data-close]").forEach((b) => b.onclick = async () => {
    if (!confirm("Close this link? It will stop accepting videos.")) return;
    await api("DELETE", "/api/requests/" + b.dataset.close); renderRequests();
  });
}

// ------------------------------------------------------------------ playlists (one page per property)

async function renderPlaylists(openId) {
  const lists = await api("GET", "/api/playlists");
  view.innerHTML = `
    <h1>Playlists</h1>
    <div class="card">
      <p class="muted" style="margin-top:0">One page with several videos, e.g. a guest guide for each property: check-in, Wi-Fi, hot tub, checkout. Send one link, or print its QR code for the unit.</p>
      <div class="row"><input id="pln" placeholder="New playlist name, e.g. Lake House - guest guide" style="flex:1"><button class="btn primary" id="plc">Create</button></div>
    </div>
    ${lists.map((p) => `<div class="card" id="pl-${p.id}">
      <div class="row spread"><div><h2 style="margin:0">${esc(p.title)}</h2>
        <div class="small muted">${p.items.length} item${p.items.length === 1 ? "" : "s"} &middot; ${p.views} views</div></div>
        <div class="row"><a class="btn" href="${esc(p.url)}" target="_blank">Open page</a>
          <button class="btn" data-copy="${esc(p.url)}">Copy link</button>
          <a class="btn" href="/api/playlists/${p.id}/qr.png${SS.mk()}" download="qr-${p.id}.png">QR code</a>
          <button class="btn danger" data-pdel="${p.id}">Delete</button></div></div>
      <input value="${esc(p.description)}" data-pdesc="${p.id}" placeholder="A line under the title (optional)" style="margin-top:10px">
      <ol class="plitems">${p.items.map((it, i) => `<li><span>${esc(it.title)}</span>
        <button class="btn" data-up="${p.id}:${i}" ${i ? "" : "disabled"}>&uarr;</button>
        <button class="btn" data-down="${p.id}:${i}" ${i < p.items.length - 1 ? "" : "disabled"}>&darr;</button>
        <button class="btn danger" data-rm="${p.id}:${i}">&times;</button></li>`).join("")}</ol>
      <button class="btn" data-addto="${p.id}">+ Add videos or screenshots</button>
    </div>`).join("")}`;
  const byId = Object.fromEntries(lists.map((p) => [p.id, p]));
  const saveOrder = async (pid, ids) => { await api("PATCH", "/api/playlists/" + pid, { videos: ids }); renderPlaylists(); };
  $("#plc").onclick = async () => { const t = $("#pln").value.trim(); if (!t) return; await api("POST", "/api/playlists", { title: t }); renderPlaylists(); };
  $$("[data-copy]").forEach((b) => b.onclick = async () => { await copyText(b.dataset.copy); toast("Link copied"); });
  $$("[data-pdel]").forEach((b) => b.onclick = async () => { if (confirm("Delete this playlist? (The videos stay in your library.)")) { await api("DELETE", "/api/playlists/" + b.dataset.pdel); renderPlaylists(); } });
  $$("[data-pdesc]").forEach((inp) => inp.onchange = async () => { await api("PATCH", "/api/playlists/" + inp.dataset.pdesc, { description: inp.value }); toast("Saved"); });
  const move = (attr, delta) => $$(`[data-${attr}]`).forEach((b) => b.onclick = () => {
    const [pid, i] = b.dataset[attr].split(":"); const ids = byId[pid].items.map((x) => x.id);
    if (delta === 0) ids.splice(+i, 1); else { const j = +i + delta; [ids[i], ids[j]] = [ids[j], ids[i]]; }
    saveOrder(pid, ids);
  });
  move("up", -1); move("down", 1); move("rm", 0);
  $$("[data-addto]").forEach((b) => b.onclick = async () => {
    const p = byId[b.dataset.addto];
    const vids = (await api("GET", "/api/videos?mine=" + (me.role === "admin" ? 0 : 1))).filter((v) => !p.items.some((i) => i.id === v.id));
    const card = modal(`<h2>Add to "${esc(p.title)}"</h2>
      <div style="max-height:50vh;overflow:auto">${vids.map((v) => `<label class="check"><input type="checkbox" value="${v.id}"> ${esc(v.title)} <span class="small muted">${v.kind === "image" ? "screenshot" : SS.fmtTime(v.duration)}</span></label>`).join("") || `<p class="muted">Nothing else to add.</p>`}</div>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="addok">Add</button><button class="btn" id="addx">Cancel</button></div>`);
    $("#addx", card).onclick = closeModal;
    $("#addok", card).onclick = async () => {
      const picked = $$("input:checked", card).map((x) => x.value);
      closeModal();
      try { await saveOrder(p.id, p.items.map((i) => i.id).concat(picked)); } catch (e) { toast(e.message, 5000); }
    };
  });
}

// ------------------------------------------------------------------ reports: totals across everyone

async function renderReports() {
  const users = me.role === "admin" ? await api("GET", "/api/users") : [];
  view.innerHTML = `
    <div class="row spread"><h1>Reports</h1><div class="row">
      ${users.length ? `<select id="ru" style="width:auto"><option value="0">Everyone</option>${users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select>` : ""}
      <select id="rd" style="width:auto"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last year</option></select>
    </div></div>
    <div id="rep"><p class="muted">Loading...</p></div>`;
  const load = async () => {
    const r = await api("GET", `/api/reports?days=${$("#rd").value}&user_id=${$("#ru")?.value || 0}`);
    const max = Math.max(1, ...r.days.map((d) => d.views + d.opens));
    $("#rep").innerHTML = `
      <div class="tiles4 card"><div><b>${r.sent}</b><span>sent</span></div><div><b>${r.opens}</b><span>email opens</span></div>
        <div><b>${r.views}</b><span>views</span></div><div><b>${r.unique_viewers}</b><span>different people</span></div></div>
      <div class="card"><h2>Each day</h2>
        <div class="daybars">${r.days.map((d) => `<div title="${d.day}: ${d.views} views, ${d.opens} opens">
          <i style="height:${(d.views / max) * 100}%"></i><i class="op" style="height:${(d.opens / max) * 100}%"></i></div>`).join("")}</div>
        <div class="rewatch-axis"><span>${r.days[0].day}</span><span><i class="key"></i>views <i class="key op"></i>email opens</span><span>${r.days[r.days.length - 1].day}</span></div></div>
      <div class="card"><h2>Most watched</h2>
        ${r.top.length ? `<table class="list"><tr><th>Video</th>${me.role === "admin" ? "<th>By</th>" : ""}<th>Views</th><th>Opens</th><th>Avg watched</th></tr>
        ${r.top.map((t) => `<tr style="cursor:pointer" onclick="location.hash='#/video/${t.id}'"><td>${esc(t.title)}</td>${me.role === "admin" ? `<td>${esc(t.owner)}</td>` : ""}<td>${t.views}</td><td>${t.opens}</td><td>${t.avg_percent}%</td></tr>`).join("")}</table>`
        : `<p class="muted">No views in this period.</p>`}</div>
      <div class="card"><h2>What people watch on</h2><p>${Object.entries(r.devices).map(([k, n]) => `<b>${n}</b> ${esc(k.toLowerCase())}`).join(" &middot; ") || "No views yet."}</p></div>`;
  };
  $("#rd").onchange = load;
  if ($("#ru")) $("#ru").onchange = load;
  await load();
}

// ------------------------------------------------------------------ team (admin)

async function renderTeam() {
  if (me.role !== "admin") { location.hash = "#/"; return; }
  const users = await api("GET", "/api/users");
  view.innerHTML = `
    <h1>Team</h1>
    <div class="card"><table class="list">
      <tr><th>Person</th><th>Videos</th><th>Sent</th><th>Opens</th><th>Views</th><th></th></tr>
      ${users.map((u) => `<tr style="${u.active ? "" : "opacity:.5"}">
        <td><b>${esc(u.name)}</b> ${u.role === "admin" ? '<span class="pill">admin</span>' : ""} ${u.pending ? '<span class="pill warn">invite not used yet</span>' : ""}
          <div class="small muted">${esc(u.email)}</div></td>
        <td>${u.videos}</td><td>${u.sent}</td><td>${u.opens}</td><td>${u.plays}</td>
        <td class="row">${u.pending && u.invite_url ? `<button class="btn" data-copy="${esc(u.invite_url)}">Copy invite link</button>` : ""}
          ${u.id !== me.id && u.role !== "admin" ? `<button class="btn" data-approval="${u.id}" data-to="${u.needs_approval ? 0 : 1}">${u.needs_approval ? "&#10004; You approve their videos" : "Approve their videos first"}</button>` : ""}
          ${u.id !== me.id ? `<button class="btn" data-reinvite="${u.id}">New sign-in link</button>
          <button class="btn ${u.active ? "danger" : ""}" data-active="${u.id}" data-to="${u.active ? 0 : 1}">${u.active ? "Turn off" : "Turn back on"}</button>` : ""}</td></tr>`).join("")}
    </table></div>
    <div class="card"><h2>Add a staff member</h2>
      <div class="grid2"><div><label>Name</label><input id="nn"></div><div><label>Email</label><input id="ne" type="email"></div></div>
      <label class="check"><input type="checkbox" id="nadmin"> Admin (sees everyone's videos and activity)</label>
      <button class="btn primary" id="add">Add and copy their invite link</button>
      <p class="small muted">Send them the invite link. They open it, choose a password, and they're in.</p>
    </div>`;
  $("#add").onclick = async () => {
    try {
      const r = await api("POST", "/api/users", { name: $("#nn").value, email: $("#ne").value, role: $("#nadmin").checked ? "admin" : "staff" });
      await copyText(r.invite_url); toast("Added. Invite link copied - send it to them."); renderTeam();
    } catch (e) { toast(e.message); }
  };
  $$("[data-copy]").forEach((b) => b.onclick = async () => { await copyText(b.dataset.copy); toast("Invite link copied"); });
  $$("[data-reinvite]").forEach((b) => b.onclick = async () => {
    const r = await api("PATCH", "/api/users/" + b.dataset.reinvite, { new_invite: true });
    await copyText(r.invite_url); toast("New sign-in link copied");
  });
  $$("[data-approval]").forEach((b) => b.onclick = async () => {
    await api("PATCH", "/api/users/" + b.dataset.approval, { needs_approval: b.dataset.to === "1" });
    toast(b.dataset.to === "1" ? "Their videos now need your OK before they can be sent" : "They can send without approval");
    renderTeam();
  });
  $$("[data-active]").forEach((b) => b.onclick = async () => {
    await api("PATCH", "/api/users/" + b.dataset.active, { active: b.dataset.to === "1" }); renderTeam();
  });
}

// ------------------------------------------------------------------ settings

async function renderSettings() {
  me = await api("GET", "/api/me");
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window;
  const isIphone = /iPhone|iPad/.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  view.innerHTML = `
    <h1>Settings</h1>
    <div class="card"><h2>How do you want to be told?</h2>
      <p class="muted" style="margin-top:0">Tick as many as you like. You're alerted every time someone opens or watches, no matter how often or how late.</p>
      <label class="check"><input type="checkbox" id="a-email" ${me.alert_email ? "checked" : ""}> Email to ${esc(me.email)}
        ${me.email_alerts_ready ? "" : '<span class="pill warn">being set up</span>'}</label>
      <label class="check"><input type="checkbox" id="a-push" ${me.alert_push ? "checked" : ""}> Pop-up alerts on my phone and computer
        <span class="small muted">(${me.push_devices} device${me.push_devices === 1 ? "" : "s"} turned on)</span></label>
      <label class="check"><input type="checkbox" id="a-text" ${me.alert_text ? "checked" : ""}> Text message to ${me.phone ? esc(me.phone) : "your phone (add your number below)"}
        ${me.texting_ready ? "" : '<span class="pill warn">starts when the texting registration is approved</span>'}</label>
      <label class="check"><input type="checkbox" id="a-opens" ${me.alert_opens ? "checked" : ""}> Also alert me when an email is opened (not just when the video is played)</label>
    </div>
    <div class="card"><h2>Pop-up alerts on this device</h2>
      ${!pushSupported ? (isIphone && !standalone
        ? `<p>On iPhone: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>. Open __COMPANY__ Video from your home screen and come back here.</p>`
        : `<p class="muted">This browser can't show pop-up alerts.</p>`)
        : `<p class="muted" style="margin-top:0">Do this once on each phone and computer you use.</p>
           <div class="row"><button class="btn primary" id="pushon">Turn on alerts here</button><button class="btn" id="pushtest">Send a test alert</button></div>`}
    </div>
    <div class="card"><h2>Your details</h2>
      <p class="muted" style="margin-top:0">Shown under your videos so people can reach you.</p>
      <div class="grid2"><div><label>Name</label><input id="myname" value="${esc(me.name)}"></div>
      <div><label>Phone</label><input id="myphone" value="${esc(me.phone)}" placeholder="(404) 555-1234"></div></div>
      <label>New password (leave blank to keep)</label><input id="mypw" type="password" autocomplete="new-password">
      <div class="row" style="margin-top:12px"><button class="btn primary" id="savemine">Save</button>
        <button class="btn" id="logout" style="margin-left:auto">Sign out</button></div>
    </div>
    <div class="card"><h2>Your signature (shown under your videos)</h2>
      <p class="muted" style="margin-top:0">The banner from your email signature. People see it under every video you send.</p>
      ${me.has_signature ? `<img src="/s/${me.id}.png?t=${Date.now()}" alt="" style="max-width:100%;width:480px;border-radius:8px;display:block;margin-bottom:10px">` : `<p class="small muted">None yet - your name and phone show instead.</p>`}
      <div class="row"><label class="btn" style="margin:0">&#8679; ${me.has_signature ? "Change" : "Upload"} picture<input type="file" id="sigfile" accept="image/*" hidden></label>
      ${me.has_signature ? `<button class="btn danger" id="sigdel">Remove</button>` : ""}</div>
    </div>
    <div class="card"><h2>Chrome button (computer)</h2>
      <p class="muted" style="margin-top:0">Puts a __COMPANY__ Video button in Chrome's toolbar (record a video or take a screenshot of any page in one click) and a Video button inside Gmail's compose window.</p>
      <a class="btn" href="/static/gmail-button.zip?v=8" download="video-button.zip">Download the Chrome button</a>
      <a class="btn" href="/static/gmail-button-help.html?v=8" target="_blank">How to install it</a>
    </div>
    <div class="card"><h2>Screenshots of programs outside Chrome (only if you need it)</h2>
      <p class="muted" style="margin-top:0">The Chrome button already screenshots web pages. Skip this unless you also want to screenshot desktop programs (QuickBooks, Excel, a PDF, a menu) with the Print Screen key. ShareX is a free Windows program that does that and drops each picture into your library with a share link.</p>
      <ol>
        <li>Install ShareX free from <a href="https://getsharex.com/" target="_blank" rel="noopener">getsharex.com</a>.</li>
        <li><a class="btn" href="/api/sharex/config" download="video-uploader.sxcu">Download your ShareX setup file</a> and double-click it. ShareX asks "make this your default uploader?" - click <b>Yes</b>.</li>
        <li>In ShareX choose <b>After capture tasks</b> &rarr; tick <b>Upload image to host</b>. Press <b>Print Screen</b> to capture.</li>
      </ol>
      <p class="small muted">The setup file holds your personal upload key - don't share it. Lost a laptop? <a href="#" id="sxreset">Make a new key</a> (old setup files stop working).</p>
    </div>
    <div class="card"><h2>On your phone</h2>
      <p class="muted" style="margin-top:0">Open <b>${esc(location.host)}</b> on your phone and sign in once. Then add it to your home screen so it opens like an app, straight to Record:</p>
      <ul><li><b>iPhone (Safari):</b> tap the Share button, then <b>Add to Home Screen</b>.</li>
      <li><b>Android (Chrome):</b> tap the &#8942; menu, then <b>Install app</b> (or <b>Add to Home screen</b>). You can then also share a video from your gallery straight to __COMPANY__.</li></ul>
    </div>`;
  const saveAlerts = () => api("PATCH", "/api/me", {
    alert_email: $("#a-email").checked, alert_push: $("#a-push").checked, alert_text: $("#a-text").checked, alert_opens: $("#a-opens").checked,
  }).then(() => toast("Saved"));
  ["#a-email", "#a-push", "#a-text", "#a-opens"].forEach((s) => $(s).onchange = saveAlerts);
  if ($("#pushon")) $("#pushon").onclick = async () => {
    try { await enablePush(); toast("Alerts are on for this device"); renderSettings(); }
    catch (e) { toast("Couldn't turn on alerts: " + e.message, 5000); }
  };
  if ($("#pushtest")) $("#pushtest").onclick = async () => { await api("POST", "/api/push/test"); toast("Test sent - it should pop up in a few seconds"); };
  $("#savemine").onclick = async () => {
    const body = { name: $("#myname").value, phone: $("#myphone").value };
    if ($("#mypw").value) body.password = $("#mypw").value;
    try { await api("PATCH", "/api/me", body); toast("Saved"); } catch (e) { toast(e.message); }
  };
  $("#sigfile").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = await fetch("/api/me/signature", { method: "PUT", body: f, credentials: "same-origin" });
    toast(r.ok ? "Signature saved" : "That file isn't a picture"); renderSettings();
  };
  if ($("#sigdel")) $("#sigdel").onclick = async () => { await fetch("/api/me/signature", { method: "PUT", body: "", credentials: "same-origin" }); renderSettings(); };
  $("#sxreset").onclick = async (e) => {
    e.preventDefault();
    if (!confirm("Make a new ShareX key? You'll need to download and open the new setup file on every computer.")) return;
    await fetch("/api/sharex/config?reset=1", { credentials: "same-origin" });
    toast("New key made - download the setup file again");
  };
  $("#logout").onclick = async () => { await api("POST", "/api/logout"); SS.keepSession(null); me = null; location.hash = "#/login"; };
}

// A yellow bar on every page until this computer or phone has alerts switched on.
async function alertsBanner() {
  let bar = document.getElementById("alertbar");
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  let on = false;
  if (supported && Notification.permission === "granted") {
    try { const reg = await navigator.serviceWorker.getRegistration("/"); on = !!(reg && await reg.pushManager.getSubscription()); } catch (e) {}
  }
  if (on || sessionStorage.getItem("alertbar-hide")) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "alertbar";
    bar.className = "alertbar";
    document.body.insertBefore(bar, document.getElementById("view"));
  }
  const iphoneNeedsApp = !supported && /iPhone|iPad/.test(navigator.userAgent);
  if (!supported && !iphoneNeedsApp) { bar.remove(); return; }
  bar.innerHTML = iphoneNeedsApp
    ? `<b>Alerts are off on this iPhone.</b> To get them: tap the Share button at the bottom of Safari, then <b>Add to Home Screen</b>, then open __COMPANY__ Video from your home screen. <a href="#" id="ab-x">Hide</a>`
    : Notification.permission === "denied"
      ? `<b>Alerts are blocked on this ${/Mobi/.test(navigator.userAgent) ? "phone" : "computer"}.</b> Click the icon to the left of the web address, set <b>Notifications</b> to <b>Allow</b>, then reload this page. <a href="#" id="ab-x">Hide</a>`
      : `<b>Alerts are off on this ${/Mobi/.test(navigator.userAgent) ? "phone" : "computer"}.</b> You won't hear when people open or watch your videos. <button class="btn primary" id="ab-on">Turn on alerts</button> <a href="#" id="ab-x">Not now</a>`;
  const x = document.getElementById("ab-x");
  if (x) x.onclick = (e) => { e.preventDefault(); sessionStorage.setItem("alertbar-hide", "1"); bar.remove(); };
  const b = document.getElementById("ab-on");
  if (b) b.onclick = async () => {
    try { await enablePush(); await api("POST", "/api/push/test"); bar.remove(); toast("Alerts are on. A test alert is on its way.", 4000); }
    catch (e) { toast("Couldn't turn on alerts: " + e.message, 5000); alertsBanner(); }
  };
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("notifications were blocked in the browser");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(me.push_key.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - me.push_key.length % 4) % 4)), (c) => c.charCodeAt(0));
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api("POST", "/api/push/subscribe", sub.toJSON());
}

// ------------------------------------------------------------------ Gmail picker (opened by the Gmail button)

async function renderPick(arg, params) {
  if (params.get("to") !== null || params.get("name") !== null || params.get("mode")) {
    const origin = params.get("origin") || "";
    sessionStorage.setItem("pick", JSON.stringify({ to: params.get("to") || "", name: params.get("name") || "",
      mode: params.get("mode") || "email", origin: /^https?:\/\/[^/]+$/.test(origin) ? origin : "" }));
  }
  const pick = JSON.parse(sessionStorage.getItem("pick") || "{}");
  $("#top").hidden = true;
  const made = params.get("made");
  const finish = async (videoId) => {
    if (pick.mode === "text") {
      // Opened from a text box on another website: ask who it's for, then type the link there.
      const r = await askRecipient({ title: "Who is this for?", want: "any", optional: true });
      if (!r) return;
      const sh = await api("POST", `/api/videos/${videoId}/shares`, { ...r, channel: "link" });
      const first = (r.recipient_name || "").split(" ")[0];
      const text = `${first ? "Hi " + first + ", h" : "H"}ere's a quick video for you: ${sh.url}`;
      sessionStorage.removeItem("pick");
      if (window.opener && pick.origin) { window.opener.postMessage({ type: "ss-video-insert", url: sh.url, text }, pick.origin); window.close(); }
      else { await copyText(text); toast("Copied - paste it where you were typing"); }
      return;
    }
    const sh = await api("POST", `/api/videos/${videoId}/shares`, { recipient_email: pick.to, recipient_name: pick.name, channel: "email" });
    sessionStorage.removeItem("pick");
    if (window.opener) {
      window.opener.postMessage({ type: "ss-video-insert", html: sh.html, url: sh.url }, "https://mail.google.com");
      window.close();
    } else { await copyHtml(sh.html, sh.url); toast("Copied - paste it into your email"); }
  };
  if (made) { view.innerHTML = `<p class="muted">Adding the video to your email...</p>`; await finish(made); return; }
  const vids = await api("GET", "/api/videos?mine=1");
  view.innerHTML = `
    <div class="row spread"><h1 style="margin:0">Add a video${pick.to ? " for " + esc(pick.name || pick.to) : ""}</h1>
      <a class="btn rec big" href="#/record">&#9679; Record new</a></div>
    ${pick.to ? "" : `<p class="small muted">Tip: add the recipient in Gmail's To box first, so you know exactly who watched.</p>`}
    <div class="tiles" style="margin-top:16px">${vids.map((v) => tile(v).replace(`href="#/video/${v.id}"`, `href="#" data-pick="${v.id}"`)).join("") || `<p class="muted">No videos yet - record one.</p>`}</div>`;
  $$("[data-pick]").forEach((a) => a.onclick = (e) => { e.preventDefault(); finish(a.dataset.pick); });
}

// The service worker handles pop-up alerts and videos shared from a phone's gallery.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
route();
