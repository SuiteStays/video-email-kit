// Screenshots from the Chrome button: whole scrolling page, visible part, or a
// dragged area. Everything is captured and joined here, on this computer,
// then saved to __COMPANY__ and opened in the editor.
const SERVER = "__SERVER__"; // filled in when the button is packaged
const MAX_HEIGHT = 30000;     // tallest picture Chrome can safely build
const MIN_GAP_MS = 600;       // Chrome allows about 2 screen grabs a second

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  if (msg.type === "capture") {
    run(msg.mode, msg.tabId).catch((e) => notifyError(msg.tabId, e));
    reply({ ok: true });
  }
  if (msg.type === "snip-get") { reply(snips.get(msg.id) || null); snips.delete(msg.id); }
  if (msg.type === "open-tab") { openInFront(msg.url).then(() => reply({ ok: true })); return true; }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "capture-full" && tab) run("full", tab.id).catch((e) => notifyError(tab.id, e));
  if (command === "capture-area") snip(0).catch((e) => console.warn(e));
});

async function run(mode, tabId) {
  if (mode === "area") return snip(0);
  if (mode === "area-delay") return snip(3);
  const tab = await chrome.tabs.get(tabId);
  let blob;
  if (mode === "visible") blob = await grabVisible(tab);
  else if (mode === "page-area") blob = await grabArea(tab);
  else blob = await grabFullPage(tab);
  if (!blob) return; // cancelled
  await saveAndEdit(blob, tab);
}

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastGrab = 0;
async function grab(windowId) {
  const wait = lastGrab + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastGrab = Date.now();
  const url = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  return createImageBitmap(await (await fetch(url)).blob());
}

async function inPage(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: "ISOLATED" });
  return res && res.result;
}

async function toBlob(canvas, type = "image/png") {
  return canvas.convertToBlob({ type, quality: 0.85 });
}

// ------------------------------------------------------------------ visible part

async function grabVisible(tab) {
  const bmp = await grab(tab.windowId);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  return toBlob(c);
}

// ------------------------------------------------------------------ dragged area

async function grabArea(tab) {
  const rect = await inPage(tab.id, pickArea);
  if (!rect) return null;
  await sleep(120); // let the selection overlay disappear before the grab
  const bmp = await grab(tab.windowId);
  const ratio = bmp.width / rect.vw;
  const w = Math.max(1, Math.round(rect.w * ratio)), h = Math.max(1, Math.round(rect.h * ratio));
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d").drawImage(bmp, Math.round(rect.x * ratio), Math.round(rect.y * ratio), w, h, 0, 0, w, h);
  return toBlob(c);
}

// Runs inside the web page: dim it, let the person drag a box, return the box.
function pickArea() {
  return new Promise((resolve) => {
    const shade = document.createElement("div");
    shade.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.25)";
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;border:2px solid #0f5c8c;background:rgba(255,255,255,.15);box-shadow:0 0 0 9999px rgba(0,0,0,.35);display:none";
    const tip = document.createElement("div");
    tip.textContent = "Drag to select an area  (Esc to cancel)";
    tip.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#16202b;color:#fff;font:600 14px Arial;padding:8px 14px;border-radius:8px";
    shade.append(box, tip);
    document.documentElement.appendChild(shade);
    let sx = 0, sy = 0, dragging = false;
    const done = (r) => { shade.remove(); window.removeEventListener("keydown", onKey, true); resolve(r); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); done(null); } };
    window.addEventListener("keydown", onKey, true);
    shade.addEventListener("mousedown", (e) => {
      dragging = true; sx = e.clientX; sy = e.clientY; tip.style.display = "none"; shade.style.background = "transparent";
      Object.assign(box.style, { display: "block", left: sx + "px", top: sy + "px", width: "0px", height: "0px" });
    });
    shade.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      Object.assign(box.style, { left: Math.min(sx, e.clientX) + "px", top: Math.min(sy, e.clientY) + "px",
        width: Math.abs(e.clientX - sx) + "px", height: Math.abs(e.clientY - sy) + "px" });
    });
    shade.addEventListener("mouseup", (e) => {
      const r = { x: Math.min(sx, e.clientX), y: Math.min(sy, e.clientY), w: Math.abs(e.clientX - sx), h: Math.abs(e.clientY - sy), vw: window.innerWidth };
      if (r.w < 5 || r.h < 5) { done(null); return; }
      done(r);
    });
  });
}

// ------------------------------------------------------------------ whole scrolling page

async function grabFullPage(tab) {
  const info = await inPage(tab.id, preparePage);
  if (!info) throw new Error("This page can't be captured");
  const positions = [];
  for (let y = 0; ; y += info.view) {
    positions.push(Math.min(y, Math.max(0, info.total - info.view)));
    if (y + info.view >= info.total) break;
  }
  let canvas = null, ctx = null, scale = 1, ratio = 1;
  try {
    for (let i = 0; i < positions.length; i++) {
      const actual = await inPage(tab.id, scrollPageTo, [positions[i], i > 0]);
      await sleep(350); // let pictures that load on scroll appear
      const bmp = await grab(tab.windowId);
      if (!canvas) {
        ratio = bmp.width / info.vw;
        const fullH = info.total * ratio;
        scale = Math.min(1, MAX_HEIGHT / fullH);
        canvas = new OffscreenCanvas(Math.round(info.rect.w * ratio * scale), Math.round(fullH * scale));
        ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(bmp,
        info.rect.x * ratio, info.rect.y * ratio, info.rect.w * ratio, info.view * ratio,
        0, actual * ratio * scale, info.rect.w * ratio * scale, info.view * ratio * scale);
      bmp.close();
    }
  } finally {
    await inPage(tab.id, restorePage).catch(() => {});
  }
  return toBlob(canvas);
}

// Runs inside the page: work out what scrolls (the page, or a big inner panel
// like Gmail's message list) and how tall it is.
function preparePage() {
  const doc = document.scrollingElement || document.documentElement;
  let target = null;
  if (doc.scrollHeight <= window.innerHeight + 4) {
    let best = null, bestExtra = 50;
    for (const el of document.querySelectorAll("body *")) {
      const st = getComputedStyle(el);
      if (!/(auto|scroll)/.test(st.overflowY)) continue;
      const extra = el.scrollHeight - el.clientHeight;
      if (extra > bestExtra && el.clientHeight > window.innerHeight * 0.3) { best = el; bestExtra = extra; }
    }
    target = best;
  }
  window.__ssv = { target, startX: window.scrollX, startY: window.scrollY,
    startInner: target ? target.scrollTop : 0, hidden: [], overflow: document.documentElement.style.overflow };
  if (target) {
    const r = target.getBoundingClientRect();
    return { vw: window.innerWidth, view: target.clientHeight, total: target.scrollHeight,
      rect: { x: r.left + target.clientLeft, y: r.top + target.clientTop, w: target.clientWidth } };
  }
  // Hide the page's scrollbar so it isn't stitched into every section.
  document.documentElement.style.overflow = "hidden";
  return { vw: window.innerWidth, view: window.innerHeight, total: doc.scrollHeight,
    rect: { x: 0, y: 0, w: window.innerWidth } };
}

function scrollPageTo(y, hideFixed) {
  const s = window.__ssv;
  if (hideFixed && !s.hidden.length) {
    // Sticky headers and floating chat buttons: show them once, at the top only.
    for (const el of document.querySelectorAll("body *")) {
      const pos = getComputedStyle(el).position;
      if ((pos === "fixed" || pos === "sticky") && el.offsetHeight) {
        s.hidden.push([el, el.style.visibility]);
        el.style.setProperty("visibility", "hidden", "important");
      }
    }
  }
  if (s.target) { s.target.scrollTop = y; return s.target.scrollTop; }
  window.scrollTo(0, y);
  return window.scrollY;
}

function restorePage() {
  const s = window.__ssv;
  if (!s) return;
  for (const [el, v] of s.hidden) el.style.visibility = v;
  document.documentElement.style.overflow = s.overflow;
  if (s.target) s.target.scrollTop = s.startInner;
  window.scrollTo(s.startX, s.startY);
  delete window.__ssv;
}

// ------------------------------------------------------------------ save to __COMPANY__

async function saveAndEdit(blob, tab) {
  const title = (tab.title || "Screenshot").slice(0, 180);
  const r = await fetch(SERVER + "/api/videos", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mime: "image/png", title, source_url: tab.url || "", folder: "Screenshots" }),
  });
  if (r.status === 401) {
    await chrome.tabs.create({ url: SERVER + "/app#/login" });
    throw new Error("Please sign in to __COMPANY__ Video first, then try again.");
  }
  if (!r.ok) throw new Error("Couldn't save the screenshot");
  const { id } = await r.json();
  // Show the result page straight away; it says "saving" until the upload is in.
  await openInFront(`${SERVER}/app#/edit/${id}?new=1`, tab);
  const piece = 8 * 1024 * 1024;
  for (let off = 0, seq = 0; off < blob.size; off += piece, seq++) {
    const put = await fetch(`${SERVER}/api/videos/${id}/chunk?seq=${seq}`, { method: "PUT", credentials: "include", body: blob.slice(off, off + piece) });
    if (!put.ok) throw new Error("Upload failed");
  }
  await fetch(`${SERVER}/api/videos/${id}/finish`, { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
}

async function notifyError(tabId, e) {
  const message = (e && e.message) || String(e);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: (m) => alert("__COMPANY__ Video: " + m), args: [message] });
  } catch (_) { console.warn(message); }
}

// ------------------------------------------------------------------ open a page and bring its window to the front

async function openInFront(url, nextTo) {
  let windowId = nextTo ? nextTo.windowId : undefined;
  if (windowId === undefined) {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const w = wins.find((x) => x.focused) || wins[0];
    windowId = w ? w.id : undefined;
  }
  const t = windowId === undefined
    ? (await chrome.windows.create({ url, focused: true, state: "maximized" })).tabs[0]
    : await chrome.tabs.create({ url, windowId, active: true, index: nextTo ? nextTo.index + 1 : undefined });
  await chrome.windows.update(t.windowId, { focused: true, drawAttention: true });
  return t;
}

// ------------------------------------------------------------------ any monitor, any window: snipping-tool style

const snips = new Map(); // frozen screen pictures waiting for the area picker

async function snip(delaySeconds) {
  // 1. Chrome's own picker: Entire screen (each monitor listed) or a Window.
  const streamId = await new Promise((resolve) => chrome.desktopCapture.chooseDesktopMedia(["screen", "window"], resolve));
  if (!streamId) return; // cancelled
  // 2. Optional wait, to open a menu or pop-up first.
  if (delaySeconds) await sleep(delaySeconds * 1000);
  // 3. Freeze one picture of it (done in the hidden helper page).
  await ensureOffscreen();
  const shot = await chrome.runtime.sendMessage({ type: "offscreen-grab", streamId });
  if (!shot || shot.error) throw new Error((shot && shot.error) || "Couldn't capture the screen");
  const id = String(Date.now());
  snips.set(id, shot);
  // 4. Show it full screen on the monitor it came from, to drag out the area.
  const display = await matchDisplay(shot.width, shot.height);
  const url = chrome.runtime.getURL("snip.html?id=" + id);
  if (display) {
    const b = display.bounds;
    const w = await chrome.windows.create({ url, type: "popup", left: b.left, top: b.top, width: b.width, height: b.height, focused: true });
    await chrome.windows.update(w.id, { state: "fullscreen", focused: true });
  } else {
    // A single window was picked: show it in a big window instead.
    await chrome.windows.create({ url, type: "popup", width: Math.min(1400, shot.width + 40), height: Math.min(950, shot.height + 80), focused: true });
  }
}

async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const have = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (have.length) return;
  }
  try {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
      justification: "Take one still picture of the screen the user picked for a screenshot." });
  } catch (e) {
    if (!/single offscreen|already/i.test(e.message)) throw e;
  }
}

// Which monitor was picked? Match the picture's size to each monitor's real pixel size.
async function matchDisplay(w, h) {
  const displays = await chrome.system.display.getInfo();
  const near = (a, b) => Math.abs(a - b) <= 4;
  for (const d of displays) {
    const mode = (d.modes || []).find((m) => m.isSelected);
    const nw = mode && mode.widthInNativePixels ? mode.widthInNativePixels : null;
    const nh = mode && mode.heightInNativePixels ? mode.heightInNativePixels : null;
    const sc = mode && mode.deviceScaleFactor ? mode.deviceScaleFactor : (d.dpiX ? d.dpiX / 96 : 1);
    const candidates = [[nw, nh], [d.bounds.width * sc, d.bounds.height * sc], [d.bounds.width, d.bounds.height]];
    if (candidates.some(([cw, ch]) => cw && ch && ((near(cw, w) && near(ch, h)) || (near(cw, h) && near(ch, w))))) return d;
  }
  return null;
}

// ------------------------------------------------------------------ keep itself up to date
// This button runs from a folder on the computer. When newer files are put in
// that folder, it reloads itself within a few minutes - nothing to click.
chrome.alarms.create("ssv-self-update", { periodInMinutes: 3 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "ssv-self-update") return;
  try {
    const onDisk = await (await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })).json();
    if (onDisk.version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch (e) { /* try again next time */ }
});
