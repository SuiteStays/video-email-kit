// Screenshot editor: arrows, boxes, text, numbered steps, callouts, blur,
// pixelate, black-out, spotlight, magnifier, emoji, crop, "hide private info",
// "copy text", "make it look nice", and exports (PNG, JPG, PDF, clipboard).
// The untouched capture is always kept, so every markup stays changeable.

const TESS = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js";
const JSPDF = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
const COLORS = ["#e5383b", "#f77f00", "#ffd60a", "#2a9d48", "#0f5c8c", "#7b2cbf", "#16202b", "#ffffff"];
const BACKDROPS = [
  ["#0f5c8c", "#4cc9f0"], ["#7b2cbf", "#f72585"], ["#2a9d48", "#a7c957"], ["#f77f00", "#fcbf49"], ["#e9edf2", "#cfd8e3"], ["#16202b", "#3a506b"],
];
const EMOJI = ["✔️", "❌", "⚠️", "⭐", "👉", "👆", "❤️", "🏠", "🔑", "❓"];
const TOOLS = [
  ["select", "&#11016;", "Select / move (Delete removes)"], ["arrow", "&#10138;", "Arrow"], ["rect", "&#9645;", "Box"],
  ["ellipse", "&#9711;", "Circle"], ["line", "&#9585;", "Line"], ["pen", "&#9998;", "Draw"], ["highlight", "&#9646;", "Highlighter"],
  ["text", "T", "Text"], ["step", "&#10102;", "Numbered step"], ["callout", "&#128172;", "Callout"],
  ["blur", "&#9672;", "Blur"], ["pixelate", "&#9638;", "Pixelate"], ["redact", "&#9632;", "Black out"],
  ["spotlight", "&#9788;", "Spotlight (dims the rest)"], ["magnify", "&#128269;", "Magnifier"], ["emoji", "&#9786;", "Stamp"],
  ["crop", "&#9986;", "Crop"],
];

const loadScript = (src) => new Promise((res, rej) => {
  if (document.querySelector(`script[src="${src}"]`)) return res();
  const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("couldn't load " + src));
  document.head.appendChild(s);
});

export async function renderEditor(view, id, h) {
  const { api, esc, toast, modal, closeModal, copyText } = h;
  const fresh = h.params && h.params.get("new") === "1";
  let v = await api("GET", "/api/videos/" + id);
  // Opened the moment the screenshot was taken: wait for the upload to land.
  if (v.status !== "ready") {
    view.innerHTML = `<div class="card" style="text-align:center;padding:50px"><h2>Saving your screenshot...</h2><p class="muted">One moment.</p></div>`;
    for (let i = 0; i < 120 && v.status !== "ready"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!location.hash.includes(id)) return;
      v = await api("GET", "/api/videos/" + id);
    }
    if (v.status !== "ready") { view.innerHTML = `<div class="card"><p class="err">The screenshot didn't finish saving. Please take it again.</p></div>`; return; }
  }
  if (v.kind !== "image" || v.mime === "image/gif") { location.hash = "#/video/" + id; return; }
  const saved = (() => { try { return JSON.parse(v.edit_json || "{}"); } catch (e) { return {}; } })();

  const base = new Image();
  base.src = `/api/videos/${id}/original?t=` + Date.now() + SS.mk("&");
  await base.decode();
  const W0 = base.naturalWidth, H0 = base.naturalHeight;

  let items = saved.items || [];
  let crop = saved.crop || null;
  let beautify = saved.beautify || { on: false, bg: 0, pad: 64 };
  let tool = "arrow", color = "#e5383b", size = 2, emoji = EMOJI[0];
  let selected = -1, undo = [], redo = [], ocr = null, dirty = false;
  const unit = Math.max(1, Math.round(Math.max(W0, 1200) / 1200)); // annotations scale with big screenshots

  view.innerHTML = `
    <div class="row spread"><a href="#/video/${id}" class="muted">&larr; Back</a>
      <input id="etitle" value="${esc(v.title)}" style="max-width:420px;font-weight:700">
      <div class="row">
        <button class="btn" id="e-undo" title="Undo (Ctrl+Z)">&#8630;</button>
        <button class="btn" id="e-redo" title="Redo (Ctrl+Y)">&#8631;</button>
        <button class="btn primary" id="e-save">Save</button>
        <button class="btn primary" id="e-send">Save &amp; send &rarr;</button>
      </div></div>
    ${fresh ? `<div class="card freshbar"><b>&#10004; Screenshot saved.</b> What next?
      <button class="btn" id="f-mark">&#9998; Mark it up</button>
      <button class="btn" id="f-copy">&#128203; Copy picture</button>
      <button class="btn" id="f-dl">&#11015; Download</button>
      <button class="btn primary" id="f-send">&#9993; Send it</button></div>` : ""}
    <div class="edtools card">
      <div class="row">${TOOLS.map(([k, ico, t]) => `<button class="tool" data-tool="${k}" title="${t}">${ico}</button>`).join("")}</div>
      <div class="row">
        ${COLORS.map((c) => `<button class="swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}
        <select id="esize" title="Thickness" style="width:auto"><option value="1">Thin</option><option value="2" selected>Medium</option><option value="4">Thick</option></select>
        <span id="emojibar" hidden>${EMOJI.map((e) => `<button class="tool emo" data-emoji="${e}">${e}</button>`).join("")}</span>
      </div>
      <div class="row">
        <button class="btn" id="e-private">&#128274; Hide private info</button>
        <button class="btn" id="e-text">&#128196; Copy text</button>
        <button class="btn" id="e-pretty">&#10024; Make it look nice</button>
        <span id="prettyopts" hidden>${BACKDROPS.map((b, i) => `<button class="swatch" data-bg="${i}" style="background:linear-gradient(135deg,${b[0]},${b[1]})"></button>`).join("")}</span>
        <button class="btn" id="e-uncrop" hidden>Undo crop</button>
        <span style="margin-left:auto" class="row">
          <button class="btn" id="e-copy">&#128203; Copy picture</button>
          <select id="e-dl" style="width:auto"><option value="">&#11015; Download...</option><option value="png">PNG picture</option><option value="jpg">JPG picture (smaller)</option><option value="pdf-letter">PDF, letter pages</option><option value="pdf-long">PDF, one long page</option></select>
        </span>
      </div>
      <p class="small muted" id="estatus" style="margin:4px 0 0"></p>
    </div>
    <div class="edstage" id="stage"><div class="edwrap" id="wrap"><div class="edinner">
      <canvas id="main"></canvas><canvas id="over"></canvas>
    </div></div></div>`;

  const main = document.getElementById("main"), over = document.getElementById("over");
  const mctx = main.getContext("2d"), octx = over.getContext("2d");
  const status = (t) => { document.getElementById("estatus").textContent = t || ""; };

  // ------------------------------------------------ drawing

  function region() { return crop || { x: 0, y: 0, w: W0, h: H0 }; }

  function sizeCanvases() {
    const r = region();
    for (const c of [main, over]) { c.width = r.w; c.height = r.h; }
    const wrap = document.getElementById("wrap");
    wrap.classList.toggle("pretty", beautify.on);
    if (beautify.on) {
      const [a, b] = BACKDROPS[beautify.bg] || BACKDROPS[0];
      wrap.style.background = `linear-gradient(135deg, ${a}, ${b})`;
    } else wrap.style.background = "";
    document.getElementById("e-uncrop").hidden = !crop;
  }

  // Draw the picture and every markup onto ctx, for the region shown.
  function paint(ctx, list, r = region()) {
    ctx.save();
    ctx.clearRect(0, 0, r.w, r.h);
    ctx.drawImage(base, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    ctx.translate(-r.x, -r.y);
    for (const it of list) drawItem(ctx, it);
    ctx.restore();
  }

  function drawItem(ctx, it, ghost = false) {
    const lw = (it.size || 2) * 2 * unit;
    ctx.save();
    ctx.strokeStyle = it.color; ctx.fillStyle = it.color; ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.lineJoin = "round";
    const b = box(it);
    switch (it.t) {
      case "rect": ctx.strokeRect(b.x, b.y, b.w, b.h); break;
      case "ellipse": ctx.beginPath(); ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2); ctx.stroke(); break;
      case "line": ctx.beginPath(); ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); ctx.stroke(); break;
      case "arrow": arrow(ctx, it.x1, it.y1, it.x2, it.y2, lw); break;
      case "pen":
        ctx.beginPath(); (it.pts || []).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); break;
      case "highlight":
        ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = "multiply"; ctx.fillStyle = it.color === "#e5383b" ? "#ffd60a" : it.color;
        ctx.fillRect(b.x, b.y, b.w, b.h); break;
      case "redact": ctx.fillStyle = "#000"; ctx.fillRect(b.x, b.y, b.w, b.h); break;
      case "blur":
        if (ghost) { dashed(ctx, b); break; }
        ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
        ctx.filter = `blur(${Math.max(8, Math.min(b.w, b.h) / 6)}px)`;
        ctx.drawImage(base, b.x - 20, b.y - 20, b.w + 40, b.h + 40, b.x - 20, b.y - 20, b.w + 40, b.h + 40); break;
      case "pixelate": {
        if (ghost) { dashed(ctx, b); break; }
        const cell = Math.max(6, Math.round(Math.min(b.w, b.h) / 8));
        const sw = Math.max(1, Math.round(b.w / cell)), sh = Math.max(1, Math.round(b.h / cell));
        const tmp = document.createElement("canvas"); tmp.width = sw; tmp.height = sh;
        tmp.getContext("2d").drawImage(base, b.x, b.y, b.w, b.h, 0, 0, sw, sh);
        ctx.imageSmoothingEnabled = false; ctx.drawImage(tmp, 0, 0, sw, sh, b.x, b.y, b.w, b.h); break;
      }
      case "spotlight": {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.beginPath(); ctx.rect(-1e5, -1e5, 2e5, 2e5); roundRect(ctx, b.x, b.y, b.w, b.h, 10 * unit);
        ctx.fill("evenodd"); break;
      }
      case "magnify": {
        const r = Math.max(10, Math.min(b.w, b.h) / 2), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(base, cx - r / 2, cy - r / 2, r, r, cx - r, cy - r, r * 2, r * 2); ctx.restore();
        ctx.lineWidth = Math.max(3, lw); ctx.strokeStyle = it.color; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); break;
      }
      case "text": {
        const fs = (it.size || 2) * 11 * unit;
        ctx.font = `700 ${fs}px -apple-system, "Segoe UI", Arial, sans-serif`; ctx.textBaseline = "top";
        ctx.lineWidth = Math.max(3, fs / 6); ctx.strokeStyle = it.color === "#ffffff" ? "#16202b" : "#ffffff";
        (it.text || "").split("\n").forEach((ln, i) => { ctx.strokeText(ln, it.x, it.y + i * fs * 1.2); ctx.fillText(ln, it.x, it.y + i * fs * 1.2); });
        break;
      }
      case "step": {
        const r = (it.size || 2) * 9 * unit;
        ctx.beginPath(); ctx.arc(it.x, it.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = Math.max(2, r / 6); ctx.strokeStyle = "#fff"; ctx.stroke();
        ctx.fillStyle = it.color === "#ffffff" || it.color === "#ffd60a" ? "#16202b" : "#fff";
        ctx.font = `800 ${r * 1.15}px Arial, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(String(it.n), it.x, it.y + r * 0.05); break;
      }
      case "callout": {
        const fs = (it.size || 2) * 9 * unit, pad = fs * 0.6;
        ctx.font = `600 ${fs}px -apple-system, "Segoe UI", Arial, sans-serif`;
        const lines = (it.text || "...").split("\n");
        const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2, th = lines.length * fs * 1.25 + pad * 2;
        it.w = tw; it.h = th;
        ctx.fillStyle = "#fff"; ctx.strokeStyle = it.color; ctx.lineWidth = Math.max(2, lw * 0.7);
        ctx.beginPath(); ctx.moveTo(it.tx, it.ty);
        const mx = it.x + tw / 2, my = it.y + th / 2;
        ctx.lineTo(mx - fs * 0.5, my); ctx.lineTo(mx + fs * 0.5, my); ctx.closePath(); ctx.fillStyle = it.color; ctx.fill();
        ctx.fillStyle = "#fff"; ctx.beginPath(); roundRect(ctx, it.x, it.y, tw, th, fs * 0.4); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#16202b"; ctx.textBaseline = "top";
        lines.forEach((ln, i) => ctx.fillText(ln, it.x + pad, it.y + pad + i * fs * 1.25)); break;
      }
      case "emoji": {
        const fs = (it.size || 2) * 22 * unit;
        ctx.font = `${fs}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(it.e, it.x, it.y); break;
      }
      case "crop": dashed(ctx, b, "#0f5c8c"); break;
    }
    ctx.restore();
  }

  function arrow(ctx, x1, y1, x2, y2, lw) {
    const a = Math.atan2(y2 - y1, x2 - x1), head = Math.max(14, lw * 4);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2 - Math.cos(a) * head * 0.8, y2 - Math.sin(a) * head * 0.8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(a - 0.45), y2 - head * Math.sin(a - 0.45));
    ctx.lineTo(x2 - head * Math.cos(a + 0.45), y2 - head * Math.sin(a + 0.45)); ctx.closePath(); ctx.fill();
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function dashed(ctx, b, c = "#16202b") {
    ctx.setLineDash([8 * unit, 6 * unit]); ctx.lineWidth = 2 * unit; ctx.strokeStyle = c; ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
  function box(it) {
    if ("x1" in it) return { x: Math.min(it.x1, it.x2), y: Math.min(it.y1, it.y2), w: Math.abs(it.x2 - it.x1), h: Math.abs(it.y2 - it.y1) };
    if (it.t === "pen") {
      const xs = it.pts.map((p) => p[0]), ys = it.pts.map((p) => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    if (it.t === "step") { const r = (it.size || 2) * 9 * unit; return { x: it.x - r, y: it.y - r, w: r * 2, h: r * 2 }; }
    if (it.t === "emoji") { const r = (it.size || 2) * 11 * unit; return { x: it.x - r, y: it.y - r, w: r * 2, h: r * 2 }; }
    if (it.t === "text") {
      const fs = (it.size || 2) * 11 * unit; mctx.font = `700 ${fs}px Arial`;
      const lines = (it.text || "").split("\n");
      return { x: it.x, y: it.y, w: Math.max(...lines.map((l) => mctx.measureText(l).width)), h: lines.length * fs * 1.2 };
    }
    return { x: it.w < 0 ? it.x + it.w : it.x, y: it.h < 0 ? it.y + it.h : it.y, w: Math.abs(it.w || 0), h: Math.abs(it.h || 0) };
  }

  function redraw() {
    paint(mctx, items);
    drawOverlay();
  }
  function drawOverlay(temp) {
    const r = region();
    octx.clearRect(0, 0, over.width, over.height);
    octx.save(); octx.translate(-r.x, -r.y);
    if (temp) drawItem(octx, temp, true);
    if (selected >= 0 && items[selected]) {
      const b = box(items[selected]);
      octx.setLineDash([6 * unit, 4 * unit]); octx.strokeStyle = "#0f5c8c"; octx.lineWidth = 2 * unit;
      octx.strokeRect(b.x - 6 * unit, b.y - 6 * unit, b.w + 12 * unit, b.h + 12 * unit);
    }
    octx.restore();
  }

  // ------------------------------------------------ history

  const snap = () => JSON.stringify({ items, crop });
  function remember() { undo.push(snap()); if (undo.length > 100) undo.shift(); redo = []; dirty = true; }
  function restore(state) { const s = JSON.parse(state); items = s.items; crop = s.crop; selected = -1; sizeCanvases(); redraw(); dirty = true; }
  document.getElementById("e-undo").onclick = () => { if (undo.length) { redo.push(snap()); restore(undo.pop()); } };
  document.getElementById("e-redo").onclick = () => { if (redo.length) { undo.push(snap()); restore(redo.pop()); } };

  // ------------------------------------------------ pointer

  const toImage = (e) => {
    const rect = main.getBoundingClientRect(), r = region();
    return [r.x + (e.clientX - rect.left) * (main.width / rect.width), r.y + (e.clientY - rect.top) * (main.height / rect.height)];
  };
  function hit(x, y) {
    for (let i = items.length - 1; i >= 0; i--) {
      const b = box(items[i]), pad = 8 * unit;
      if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) return i;
    }
    return -1;
  }
  let drag = null;
  over.addEventListener("pointerdown", (e) => {
    over.setPointerCapture(e.pointerId);
    const [x, y] = toImage(e);
    const common = { color, size };
    if (tool === "select") {
      selected = hit(x, y);
      if (selected >= 0) { remember(); drag = { move: true, x, y, orig: JSON.parse(JSON.stringify(items[selected])) }; }
      drawOverlay(); return;
    }
    if (tool === "text") { addText(e, x, y, common); return; }
    if (tool === "step") { remember(); items.push({ t: "step", x, y, n: items.filter((i) => i.t === "step").length + 1, ...common }); redraw(); return; }
    if (tool === "emoji") { remember(); items.push({ t: "emoji", x, y, e: emoji, ...common }); redraw(); return; }
    if (["arrow", "line"].includes(tool)) drag = { item: { t: tool, x1: x, y1: y, x2: x, y2: y, ...common } };
    else if (tool === "pen") drag = { item: { t: "pen", pts: [[x, y]], ...common } };
    else if (tool === "callout") drag = { item: { t: "callout", tx: x, ty: y, x, y, ...common } };
    else drag = { item: { t: tool, x, y, w: 0, h: 0, ...common } };
  });
  over.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [x, y] = toImage(e);
    if (drag.move) {
      const it = items[selected], o = drag.orig, dx = x - drag.x, dy = y - drag.y;
      for (const k of ["x", "x1", "x2", "tx"]) if (k in o) it[k] = o[k] + dx;
      for (const k of ["y", "y1", "y2", "ty"]) if (k in o) it[k] = o[k] + dy;
      if (o.pts) it.pts = o.pts.map(([px, py]) => [px + dx, py + dy]);
      redraw(); return;
    }
    const it = drag.item;
    if ("x1" in it) { it.x2 = x; it.y2 = y; }
    else if (it.t === "pen") it.pts.push([x, y]);
    else if (it.t === "callout") { it.x = x; it.y = y; }
    else { it.w = x - it.x; it.h = y - it.y; }
    drawOverlay(it);
  });
  over.addEventListener("pointerup", async (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.move) return;
    const it = d.item;
    if (it.t === "callout") {
      const text = await askText("Callout text");
      drawOverlay();
      if (!text) return;
      remember(); it.text = text; items.push(it); redraw(); return;
    }
    if ("w" in it) { const b = box(it); Object.assign(it, b); if (b.w < 4 || b.h < 4) { drawOverlay(); return; } }
    if (it.t === "crop") {
      remember(); crop = { x: Math.round(it.x), y: Math.round(it.y), w: Math.round(it.w), h: Math.round(it.h) };
      tool = "select"; markTool(); sizeCanvases(); redraw(); return;
    }
    if ("x1" in it && Math.hypot(it.x2 - it.x1, it.y2 - it.y1) < 4) { drawOverlay(); return; }
    remember(); items.push(it); redraw();
  });

  function askText(label, value = "") {
    return new Promise((resolve) => {
      const card = modal(`<h2>${esc(label)}</h2><textarea id="tt" rows="3">${esc(value)}</textarea>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="tok">Add</button><button class="btn" id="tx">Cancel</button></div>`);
      const ta = card.querySelector("#tt"); ta.focus();
      ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); card.querySelector("#tok").click(); } };
      card.querySelector("#tok").onclick = () => { const t = ta.value.trim(); closeModal(); resolve(t); };
      card.querySelector("#tx").onclick = () => { closeModal(); resolve(""); };
    });
  }
  async function addText(e, x, y, common) {
    const text = await askText("Text to add");
    if (!text) return;
    remember(); items.push({ t: "text", x, y, text, ...common }); redraw();
  }
  over.addEventListener("dblclick", async (e) => {
    const [x, y] = toImage(e); const i = hit(x, y);
    if (i >= 0 && ["text", "callout"].includes(items[i].t)) {
      const t = await askText("Change text", items[i].text);
      if (t) { remember(); items[i].text = t; redraw(); }
    }
  });
  window.addEventListener("keydown", onKey);
  function onKey(e) {
    if (!document.body.contains(main)) { window.removeEventListener("keydown", onKey); return; }
    if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selected >= 0) { remember(); items.splice(selected, 1); selected = -1; redraw(); e.preventDefault(); }
    if (e.ctrlKey && e.key.toLowerCase() === "z") { document.getElementById("e-undo").click(); e.preventDefault(); }
    if (e.ctrlKey && e.key.toLowerCase() === "y") { document.getElementById("e-redo").click(); e.preventDefault(); }
  }

  // ------------------------------------------------ toolbar

  function markTool() {
    document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
    document.getElementById("emojibar").hidden = tool !== "emoji";
    over.style.cursor = tool === "select" ? "default" : "crosshair";
  }
  document.querySelectorAll("[data-tool]").forEach((b) => b.onclick = () => { tool = b.dataset.tool; selected = -1; markTool(); drawOverlay(); });
  document.querySelectorAll("[data-color]").forEach((b) => b.onclick = () => {
    color = b.dataset.color;
    document.querySelectorAll("[data-color]").forEach((x) => x.classList.toggle("on", x === b));
    if (selected >= 0) { remember(); items[selected].color = color; redraw(); }
  });
  document.getElementById("esize").onchange = (e) => {
    size = Number(e.target.value);
    if (selected >= 0) { remember(); items[selected].size = size; redraw(); }
  };
  document.querySelectorAll("[data-emoji]").forEach((b) => b.onclick = () => { emoji = b.dataset.emoji; });
  document.getElementById("e-uncrop").onclick = () => { remember(); crop = null; sizeCanvases(); redraw(); };
  document.getElementById("e-pretty").onclick = () => {
    beautify.on = !beautify.on; dirty = true;
    document.getElementById("prettyopts").hidden = !beautify.on;
    document.getElementById("e-pretty").classList.toggle("primary", beautify.on);
    sizeCanvases();
  };
  document.querySelectorAll("[data-bg]").forEach((b) => b.onclick = () => { beautify.bg = Number(b.dataset.bg); dirty = true; sizeCanvases(); });
  document.getElementById("etitle").onchange = async (e) => { await api("PATCH", "/api/videos/" + id, { title: e.target.value }); toast("Title saved"); };

  // ------------------------------------------------ reading text (OCR), free, on this computer

  async function readText(progress) {
    if (ocr) return ocr;
    const mod = await import(TESS);
    const { createWorker } = mod.default || mod;
    const worker = await createWorker("eng", 1, {
      logger: (m) => { if (progress && m.status === "recognizing text") progress(Math.round(m.progress * 100)); },
    });
    const { data } = await worker.recognize(base);
    await worker.terminate();
    ocr = data;
    if (!v.transcript && data.text.trim()) api("PATCH", "/api/videos/" + id, { transcript: data.text.slice(0, 100000) }).catch(() => {});
    return data;
  }

  // Words that look private: emails, phone numbers, card and account numbers, codes and passwords.
  const PRIVATE = [
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,
    /\b(?:\d[ -]?){13,19}\b/g,
    /\b\d{6,}\b/g,
    // "code: 4821", "gate code is 1234#", "wifi password Lake2024": the value after the word (it must hold a digit)
    /\b(?:code|pin|passcode|password|pass|gate|lockbox|door|wifi|wi-fi|key)\b[\s:#=-]*(?:is\s+)?([A-Za-z0-9#*!@$%-]*\d[A-Za-z0-9#*!@$%-]*)/gi,
  ];
  document.getElementById("e-private").onclick = async () => {
    status("Reading the picture to find private info... (first time takes a few seconds)");
    try {
      const data = await readText((p) => status(`Reading the picture... ${p}%`));
      const found = [];
      for (const line of data.lines || []) {
        const words = line.words || [];
        let text = "", spans = [];
        for (const w of words) { spans.push([text.length, text.length + w.text.length, w]); text += w.text + " "; }
        for (const re of PRIVATE) {
          re.lastIndex = 0; let m;
          while ((m = re.exec(text))) {
            let start = m.index, end = m.index + m[0].length;
            if (m[1] && re === PRIVATE[4]) { start = m.index + m[0].lastIndexOf(m[1]); end = start + m[1].length; }
            const hitWords = spans.filter(([a, b]) => b > start && a < end).map((s) => s[2]);
            if (!hitWords.length) continue;
            const x0 = Math.min(...hitWords.map((w) => w.bbox.x0)), y0 = Math.min(...hitWords.map((w) => w.bbox.y0));
            const x1 = Math.max(...hitWords.map((w) => w.bbox.x1)), y1 = Math.max(...hitWords.map((w) => w.bbox.y1));
            const pad = 3 * unit;
            found.push({ t: "pixelate", x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2, color, size });
          }
        }
      }
      if (!found.length) { status("No private info found. You can still blur anything by hand with the Blur tool."); return; }
      remember(); items.push(...found); redraw();
      status(`Hid ${found.length} item${found.length === 1 ? "" : "s"}. Check the picture; click one with Select and press Delete to put it back.`);
    } catch (e) { status("Couldn't read the picture: " + e.message); }
  };
  document.getElementById("e-text").onclick = async () => {
    status("Reading the text in the picture...");
    try {
      const data = await readText((p) => status(`Reading the picture... ${p}%`));
      status("");
      const card = modal(`<h2>Text in this picture</h2><textarea id="ocrt" rows="12">${esc(data.text.trim())}</textarea>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="ocrc">Copy all</button><button class="btn" id="ocrx">Close</button></div>`);
      card.querySelector("#ocrc").onclick = async () => { await copyText(card.querySelector("#ocrt").value); toast("Text copied"); };
      card.querySelector("#ocrx").onclick = closeModal;
    } catch (e) { status("Couldn't read the picture: " + e.message); }
  };

  // ------------------------------------------------ output

  function finalCanvas() {
    const r = region();
    const c = document.createElement("canvas");
    if (!beautify.on) { c.width = r.w; c.height = r.h; paint(c.getContext("2d"), items); return c; }
    const pad = Math.round(Math.max(40, Math.min(r.w, r.h) * 0.06));
    c.width = r.w + pad * 2; c.height = r.h + pad * 2;
    const ctx = c.getContext("2d");
    const [a, b] = BACKDROPS[beautify.bg] || BACKDROPS[0];
    const g = ctx.createLinearGradient(0, 0, c.width, c.height); g.addColorStop(0, a); g.addColorStop(1, b);
    ctx.fillStyle = g; ctx.fillRect(0, 0, c.width, c.height);
    const inner = document.createElement("canvas"); inner.width = r.w; inner.height = r.h; paint(inner.getContext("2d"), items);
    const rad = Math.round(Math.min(r.w, r.h) * 0.02) + 6;
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = pad * 0.6; ctx.shadowOffsetY = pad * 0.15;
    ctx.beginPath(); roundRect(ctx, pad, pad, r.w, r.h, rad); ctx.fillStyle = "#fff"; ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); roundRect(ctx, pad, pad, r.w, r.h, rad); ctx.clip(); ctx.drawImage(inner, pad, pad); ctx.restore();
    return c;
  }
  const toBlob = (c, type = "image/png", q = 0.9) => new Promise((res) => c.toBlob(res, type, q));
  const fileBase = () => (document.getElementById("etitle").value || "screenshot").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "screenshot";
  function download(blob, name) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function save() {
    status("Saving...");
    const c = finalCanvas();
    const blob = await toBlob(c);
    const piece = 8 * 1024 * 1024;
    for (let off = 0, seq = 0; off < blob.size; off += piece, seq++) {
      const r = await fetch(`/api/videos/${id}/edit?seq=${seq}`, { method: "PUT", credentials: "same-origin", body: blob.slice(off, off + piece) });
      if (!r.ok) throw new Error("upload failed");
    }
    await api("POST", `/api/videos/${id}/edit/finish`, { mime: "image/png", edit_json: JSON.stringify({ items, crop, beautify }) });
    // Preview picture for emails and texts: the top of the image, like a page preview.
    const t = document.createElement("canvas"); const tw = Math.min(1280, c.width);
    t.width = tw; t.height = Math.min(Math.round(c.height * tw / c.width), Math.round(tw * 0.75));
    t.getContext("2d").drawImage(c, 0, 0, c.width, t.height * c.width / tw, 0, 0, tw, t.height);
    await fetch(`/api/videos/${id}/thumb`, { method: "PUT", credentials: "same-origin", body: await toBlob(t, "image/jpeg", 0.85) });
    dirty = false; status("Saved."); toast("Saved");
  }
  document.getElementById("e-save").onclick = () => save().catch((e) => status("Save failed: " + e.message));
  document.getElementById("e-send").onclick = async () => {
    try { if (dirty || !v.has_thumb) await save(); location.hash = "#/video/" + id; } catch (e) { status("Save failed: " + e.message); }
  };
  document.getElementById("e-copy").onclick = async () => {
    try {
      const blob = await toBlob(finalCanvas());
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Picture copied - paste it anywhere");
    } catch (e) { toast("Couldn't copy: " + e.message); }
  };
  document.getElementById("e-dl").onchange = async (e) => {
    const what = e.target.value; e.target.value = "";
    if (!what) return;
    const c = finalCanvas();
    if (what === "png") return download(await toBlob(c), fileBase() + ".png");
    if (what === "jpg") return download(await toBlob(c, "image/jpeg", 0.88), fileBase() + ".jpg");
    status("Making the PDF...");
    await loadScript(JSPDF);
    const { jsPDF } = window.jspdf;
    let pdf;
    if (what === "pdf-letter") {
      // Letter pages, 0.4 inch margins, the picture cut into page-sized slices.
      pdf = new jsPDF({ unit: "pt", format: "letter" });
      const pw = 612 - 58, ph = 792 - 58, sc = pw / c.width, sliceH = Math.floor(ph / sc);
      for (let y = 0, page = 0; y < c.height; y += sliceH, page++) {
        const h2 = Math.min(sliceH, c.height - y);
        const s = document.createElement("canvas"); s.width = c.width; s.height = h2;
        s.getContext("2d").drawImage(c, 0, y, c.width, h2, 0, 0, c.width, h2);
        if (page) pdf.addPage();
        pdf.addImage(s.toDataURL("image/jpeg", 0.9), "JPEG", 29, 29, pw, h2 * sc);
      }
    } else {
      // One long page (PDF pages top out at 200 inches; longer pictures continue on a second page).
      const maxPt = 14400, w = Math.min(c.width, 1600), sc = w / c.width, slice = Math.floor(maxPt / sc);
      for (let y = 0, page = 0; y < c.height; y += slice, page++) {
        const h2 = Math.min(slice, c.height - y);
        const s = document.createElement("canvas"); s.width = c.width; s.height = h2;
        s.getContext("2d").drawImage(c, 0, y, c.width, h2, 0, 0, c.width, h2);
        const size = [w, h2 * sc];
        if (!page) pdf = new jsPDF({ unit: "pt", format: size, orientation: size[0] > size[1] ? "l" : "p" });
        else pdf.addPage(size, size[0] > size[1] ? "l" : "p");
        pdf.addImage(s.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, size[0], size[1]);
      }
    }
    pdf.save(fileBase() + ".pdf"); status("");
  };
  window.addEventListener("beforeunload", (e) => { if (dirty && document.body.contains(main)) { e.preventDefault(); e.returnValue = ""; } });

  // ------------------------------------------------ "what next?" bar on a brand-new screenshot
  if (fresh) {
    const bar = view.querySelector(".freshbar");
    view.querySelector("#f-mark").onclick = () => { bar.remove(); tool = "arrow"; markTool(); toast("Pick a tool above and draw on the picture"); };
    view.querySelector("#f-copy").onclick = () => document.getElementById("e-copy").click();
    view.querySelector("#f-dl").onclick = () => { const s = document.getElementById("e-dl"); s.value = "png"; s.dispatchEvent(new Event("change")); };
    view.querySelector("#f-send").onclick = () => document.getElementById("e-send").click();
  }

  // ------------------------------------------------ start
  document.getElementById("prettyopts").hidden = !beautify.on;
  document.getElementById("e-pretty").classList.toggle("primary", beautify.on);
  document.querySelector(`[data-color="${color}"]`).classList.add("on");
  markTool(); sizeCanvases(); redraw();
  if (v.source_url) status("From " + v.source_url);
  // New capture with no preview picture yet: make one so emails and texts look right.
  if (!v.has_thumb) save().then(() => status(v.source_url ? "From " + v.source_url : "")).catch(() => {});
  // Read the words in the picture once, quietly, so the library search finds them.
  if (!v.transcript && W0 * H0 < 25e6) setTimeout(() => readText().catch(() => {}), 1500);
}

// Any monitor, any window (including pop-up windows and open menus), and
// then drag out exactly the area you want - like the Windows Snipping Tool.
//  1. Chrome asks what to share: pick a monitor (Screen 1, Screen 2...) or a window.
//  2. A small floating "Capture" panel stays on top of everything, so you can
//     open the pop-up or menu you want first. A timer is there for menus that
//     close when you click elsewhere.
//  3. The picture freezes; drag a box around the part you want (or keep it all).
export async function renderScreenGrab(view, h) {
  const { api, toast } = h;
  view.innerHTML = `
    <h1>Screenshot any screen, window or area</h1>
    <div class="card" id="g-start">
      <ol class="steps">
        <li>Click <b>Start</b>. Chrome asks what to share: pick <b>Entire screen</b> and the monitor you want (Screen 1, Screen 2...), or <b>Window</b> for one program or pop-up window.</li>
        <li>A small <b>Capture</b> panel floats on top of everything. Get your screen ready (open the pop-up or menu), then press <b>Capture</b> - or use the timer for menus that close when you click.</li>
        <li>Drag a box around the part you want, or keep the whole thing.</li>
      </ol>
      <div class="row"><button class="btn primary big" id="g-go">Start</button>
        <label class="small muted"><input type="checkbox" id="g-quick" style="width:auto"> Skip the floating panel and capture after the timer</label>
        <select id="g-delay" style="width:auto"><option value="3">3 seconds</option><option value="5">5 seconds</option><option value="10">10 seconds</option></select></div>
      <p class="small muted" id="g-stat"></p>
    </div>
    <div id="g-pick" hidden>
      <div class="row spread" style="margin-bottom:8px"><b>Drag a box around the part you want.</b>
        <div class="row">
          <button class="btn" id="g-full">&#9974; Bigger</button>
          <button class="btn" id="g-again">&#8635; Retake</button>
          <button class="btn" id="g-all">Keep the whole thing</button>
          <button class="btn primary" id="g-use" disabled>Use this area</button></div></div>
      <div class="snipwrap" id="g-wrap"><span class="snipsize" id="g-size"></span><div class="snipinner"><canvas id="g-img"></canvas><canvas id="g-sel"></canvas></div></div>
    </div>
    <p class="small muted">Tip: for one-key desktop screenshots without the Chrome prompt, ShareX (in Settings) does the same and saves straight to your library.</p>`;

  const $ = (s) => view.querySelector(s);
  let shot = null, sel = null;

  async function grabFrame(stream) {
    const v = document.createElement("video"); v.srcObject = stream; v.muted = true; await v.play();
    await new Promise((r) => setTimeout(r, 250));
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    stream.getTracks().forEach((t) => t.stop());
    return c;
  }

  // The floating panel (Chrome's "picture-in-picture" window stays above all programs).
  function floatingPanel(stream) {
    return new Promise(async (resolve) => {
      const delay = Number($("#g-delay").value);
      const done = (how) => resolve(how);
      if (!("documentPictureInPicture" in window)) {
        $("#g-stat").innerHTML = `Capturing in ${delay} seconds - get your screen ready...`;
        setTimeout(() => done("now"), delay * 1000);
        return;
      }
      const pip = await documentPictureInPicture.requestWindow({ width: 260, height: 150 });
      pip.document.body.innerHTML = `
        <style>body{margin:0;font:600 14px Arial,sans-serif;background:#0f5c8c;color:#fff;display:grid;gap:8px;padding:12px;place-content:center;text-align:center}
        button{font:700 15px Arial;border:0;border-radius:10px;padding:10px 14px;cursor:pointer}
        #now{background:#fff;color:#0f5c8c} #later{background:#0a4569;color:#fff} #x{background:none;color:#cfe3f1;font-size:12px}</style>
        <button id="now">&#128247; Capture now</button>
        <button id="later">&#9201; Capture in ${delay} seconds</button>
        <button id="x">Cancel</button>`;
      const d = pip.document;
      const finish = (how) => { pip.close(); setTimeout(() => done(how), 350); }; // let the panel disappear first
      d.getElementById("now").onclick = () => finish("now");
      d.getElementById("x").onclick = () => finish("cancel");
      d.getElementById("later").onclick = () => {
        let n = delay;
        const b = d.getElementById("later");
        d.getElementById("now").remove();
        const tick = () => { if (n <= 0) { finish("now"); return; } b.textContent = `Capturing in ${n}...`; n--; setTimeout(tick, 1000); };
        tick();
      };
      pip.addEventListener("pagehide", () => done("cancel"), { once: true });
      stream.getVideoTracks()[0].addEventListener("ended", () => { try { pip.close(); } catch (e) {} done("cancel"); });
    });
  }

  async function start() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 7680 }, height: { ideal: 4320 }, frameRate: 5 }, audio: false,
        selfBrowserSurface: "include", surfaceSwitching: "include", monitorTypeSurfaces: "include",
      });
    } catch (e) { toast("Cancelled"); return; }
    let how = "now";
    if ($("#g-quick").checked) {
      const delay = Number($("#g-delay").value);
      for (let s = delay; s > 0; s--) { $("#g-stat").textContent = `Capturing in ${s}...`; await new Promise((r) => setTimeout(r, 1000)); }
    } else {
      $("#g-stat").textContent = "Use the floating Capture panel when your screen is ready.";
      how = await floatingPanel(stream);
    }
    if (how === "cancel") { stream.getTracks().forEach((t) => t.stop()); $("#g-stat").textContent = ""; return; }
    shot = await grabFrame(stream);
    $("#g-stat").textContent = "";
    showPicker();
  }

  function showPicker() {
    $("#g-start").hidden = true; $("#g-pick").hidden = false;
    const img = $("#g-img"), over = $("#g-sel");
    for (const c of [img, over]) { c.width = shot.width; c.height = shot.height; }
    img.getContext("2d").drawImage(shot, 0, 0);
    sel = null; drawSel();
    $("#g-size").textContent = `${shot.width} x ${shot.height}`;
    let a = null;
    const pt = (e) => { const r = over.getBoundingClientRect(); return [(e.clientX - r.left) * over.width / r.width, (e.clientY - r.top) * over.height / r.height]; };
    over.onpointerdown = (e) => { over.setPointerCapture(e.pointerId); a = pt(e); sel = null; drawSel(); };
    over.onpointermove = (e) => {
      if (!a) return;
      const b = pt(e);
      sel = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
      drawSel();
    };
    over.onpointerup = () => { a = null; if (sel && (sel.w < 8 || sel.h < 8)) sel = null; drawSel(); };
  }

  function drawSel() {
    const over = $("#g-sel"), ctx = over.getContext("2d");
    ctx.clearRect(0, 0, over.width, over.height);
    $("#g-use").disabled = !sel;
    if (!sel) { $("#g-size").textContent = shot ? `${shot.width} x ${shot.height} - drag to pick an area` : ""; return; }
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.beginPath(); ctx.rect(0, 0, over.width, over.height); ctx.rect(sel.x, sel.y, sel.w, sel.h); ctx.fill("evenodd");
    ctx.strokeStyle = "#4cc9f0"; ctx.lineWidth = Math.max(2, over.width / 800); ctx.setLineDash([10, 6]);
    ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
    $("#g-size").textContent = `${Math.round(sel.w)} x ${Math.round(sel.h)}`;
  }

  async function save(region) {
    const r = region || { x: 0, y: 0, w: shot.width, h: shot.height };
    const c = document.createElement("canvas"); c.width = Math.round(r.w); c.height = Math.round(r.h);
    c.getContext("2d").drawImage(shot, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    $("#g-use").disabled = true; $("#g-size").textContent = "Saving...";
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    const title = "Screen capture " + new Date().toLocaleString();
    const { id } = await api("POST", "/api/videos", { mime: "image/png", title, folder: "Screenshots" });
    await SS.uploadInPieces(blob, (seq) => `/api/videos/${id}/chunk?seq=${seq}`, null);
    await api("POST", `/api/videos/${id}/finish`, { title });
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    window.focus();
    location.hash = "#/edit/" + id + "?new=1";
  }

  $("#g-go").onclick = start;
  $("#g-use").onclick = () => sel && save(sel);
  $("#g-all").onclick = () => save(null);
  $("#g-again").onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); $("#g-pick").hidden = true; $("#g-start").hidden = false; start(); };
  $("#g-full").onclick = () => {
    const w = $("#g-pick");
    if (document.fullscreenElement) document.exitFullscreen(); else w.requestFullscreen().catch(() => {});
  };
  window.addEventListener("keydown", function onKey(e) {
    if (!document.body.contains($("#g-pick") || document.createElement("i"))) { window.removeEventListener("keydown", onKey); return; }
    if ($("#g-pick").hidden) return;
    if (e.key === "Enter" && sel) save(sel);
    if (e.key === "Escape") { sel = null; drawSel(); }
  });
}
