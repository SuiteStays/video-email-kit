// Full-screen "select an area" over a frozen picture of the screen the person
// picked - shown on that same monitor, so it works like the Snipping Tool.
const SERVER = "__SERVER__"; // filled in when the button is packaged
const id = new URLSearchParams(location.search).get("id");
const pic = document.getElementById("pic"), sel = document.getElementById("sel");
const sizeTag = document.getElementById("size");
let img = null, box = null, start = null, scale = 1;

chrome.runtime.sendMessage({ type: "snip-get", id }, async (res) => {
  if (!res || !res.dataUrl) { alert("__COMPANY__ Video: the screen picture was lost - please try again."); window.close(); return; }
  img = new Image();
  img.src = res.dataUrl;
  await img.decode();
  layout();
  addEventListener("resize", layout);
});

// Fit the frozen picture to this window (exactly 1:1 when it's full screen on the same monitor).
function layout() {
  scale = Math.min(innerWidth / img.naturalWidth, innerHeight / img.naturalHeight);
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const left = Math.round((innerWidth - w) / 2), top = Math.round((innerHeight - h) / 2);
  for (const c of [pic, sel]) {
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    Object.assign(c.style, { width: w + "px", height: h + "px", left: left + "px", top: top + "px" });
  }
  pic.getContext("2d").drawImage(img, 0, 0);
  draw();
}

const toImage = (e) => {
  const r = sel.getBoundingClientRect();
  return [Math.max(0, Math.min(img.naturalWidth, (e.clientX - r.left) / scale)),
          Math.max(0, Math.min(img.naturalHeight, (e.clientY - r.top) / scale))];
};

function draw() {
  const ctx = sel.getContext("2d");
  ctx.clearRect(0, 0, sel.width, sel.height);
  ctx.fillStyle = "rgba(0,0,0,.4)";
  ctx.beginPath(); ctx.rect(0, 0, sel.width, sel.height);
  if (box) ctx.rect(box.x, box.y, box.w, box.h);
  ctx.fill("evenodd");
  document.getElementById("use").disabled = !box;
  if (!box) { sizeTag.style.display = "none"; return; }
  ctx.strokeStyle = "#4cc9f0"; ctx.lineWidth = Math.max(2, 2 / scale); ctx.setLineDash([8 / scale, 5 / scale]);
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  const r = sel.getBoundingClientRect();
  sizeTag.textContent = `${Math.round(box.w)} x ${Math.round(box.h)}`;
  Object.assign(sizeTag.style, { display: "block", left: r.left + box.x * scale + "px", top: Math.max(0, r.top + box.y * scale - 26) + "px" });
}

sel.addEventListener("pointerdown", (e) => { sel.setPointerCapture(e.pointerId); start = toImage(e); box = null; draw(); });
sel.addEventListener("pointermove", (e) => {
  if (!start) return;
  const [x, y] = toImage(e);
  box = { x: Math.min(start[0], x), y: Math.min(start[1], y), w: Math.abs(x - start[0]), h: Math.abs(y - start[1]) };
  draw();
});
sel.addEventListener("pointerup", () => { start = null; if (box && (box.w < 6 || box.h < 6)) box = null; draw(); });
sel.addEventListener("dblclick", () => { if (box) save(box); });

document.getElementById("use").onclick = () => box && save(box);
document.getElementById("all").onclick = () => save(null);
document.getElementById("x").onclick = () => window.close();
addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.close();
  if (e.key === "Enter" && box) save(box);
});

async function save(region) {
  const r = region || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  document.getElementById("busy").style.display = "grid";
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(r.w)); c.height = Math.max(1, Math.round(r.h));
  c.getContext("2d").drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  try {
    const title = "Screenshot " + new Date().toLocaleString();
    const made = await fetch(SERVER + "/api/videos", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mime: "image/png", title, folder: "Screenshots" }) });
    if (made.status === 401) { await chrome.runtime.sendMessage({ type: "open-tab", url: SERVER + "/app#/login" }); alert("Please sign in to __COMPANY__ Video, then try again."); window.close(); return; }
    const { id: vid } = await made.json();
    // Open the result page straight away; it shows "saving" until the upload is in.
    await chrome.runtime.sendMessage({ type: "open-tab", url: `${SERVER}/app#/edit/${vid}?new=1` });
    const piece = 8 * 1024 * 1024;
    for (let off = 0, seq = 0; off < blob.size; off += piece, seq++) {
      await fetch(`${SERVER}/api/videos/${vid}/chunk?seq=${seq}`, { method: "PUT", credentials: "include", body: blob.slice(off, off + piece) });
    }
    await fetch(`${SERVER}/api/videos/${vid}/finish`, { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
  } catch (e) {
    alert("__COMPANY__ Video: couldn't save the screenshot - " + e.message);
  }
  window.close();
}
