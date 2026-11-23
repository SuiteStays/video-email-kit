// Watch page: plays the video and reports play, how far they got, clicks,
// likes and replies back to the sender.
(function () {
  const W = window.WATCH;
  // A staff member previewing their own link on a phone that drops cookies: still not a "view".
  const senderKey = (h) => { try { const k = localStorage.getItem("ss_session"); if (k) h["X-Session"] = k; } catch (e) {} return h; };
  const send = (body) =>
    fetch("/e/" + W.token, { method: "POST", headers: senderKey({ "Content-Type": "application/json" }),
      body: JSON.stringify(body), credentials: "same-origin", keepalive: true })
      .then((r) => r.json()).catch(() => ({}));

  // ---- password
  const unlock = document.getElementById("unlock");
  if (unlock) {
    unlock.addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await fetch("/v/" + W.token + "/unlock", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: document.getElementById("pw").value }) });
      if (r.ok) location.reload();
      else document.getElementById("pwerr").textContent = "That password is not right.";
    });
  }

  // ---- screenshot: one "view" per visit once the picture has loaded, and
  // the agree button is available straight away.
  const pic = document.getElementById("pic");
  if (pic) {
    const seen = () => { send({ kind: "play" }); if (W.confirm) unlockConfirm(); };
    if (pic.complete && pic.naturalWidth) seen(); else pic.addEventListener("load", seen, { once: true });
  }

  // ---- player
  const vid = document.getElementById("vid");
  const big = document.getElementById("bigplay");
  if (vid) {
    const start = W.trimStart || 0;
    let end = W.trimEnd || 0;
    let viewId = null;
    const buckets = new Array(20).fill(0);
    let lastIdx = -1;
    let lastSent = 0;
    let playing = false;

    const length = () => (end || vid.duration || W.duration || 0) - start;
    vid.addEventListener("loadedmetadata", () => {
      if (!isFinite(vid.duration) && W.duration) end = end || W.duration;
      if (start) vid.currentTime = start;
    });
    big.addEventListener("click", () => { vid.play(); });
    vid.addEventListener("play", async () => {
      big.hidden = true;
      vid.controls = true;
      if (vid.currentTime < start) vid.currentTime = start;
      if (!playing) {
        playing = true;
        if (viewId === null) {
          viewId = 0;
          const r = await send({ kind: "play" });
          viewId = r.view || null;
        }
      }
    });
    const skips = W.skips || [];
    vid.addEventListener("timeupdate", () => {
      let t = vid.currentTime;
      // Jump over any sections that were cut out.
      for (const [a, b] of skips) {
        if (t >= a && t < b - 0.05) { vid.currentTime = b; t = b; break; }
      }
      if (end && t >= end) { vid.pause(); vid.currentTime = end; }
      if (W.confirm && len_watched() >= 0.9) unlockConfirm();
      const len = length();
      if (len > 0 && t >= start) {
        // Count each 5% slice once per pass, so replays show on the rewatch map.
        const i = Math.min(19, Math.floor(((t - start) / len) * 20));
        if (i !== lastIdx) { buckets[i] = Math.min(9, buckets[i] + 1); lastIdx = i; }
      }
      if (viewId && Date.now() - lastSent > 5000) report();
    });
    vid.addEventListener("seeking", () => {
      if (vid.currentTime < start) vid.currentTime = start;
      lastIdx = -1;
    });
    // Share of the (cut) video they've actually seen, 0..1.
    function len_watched() {
      return buckets.filter((n) => n > 0).length / 20;
    }
    vid.addEventListener("pause", () => { playing = false; report(); });
    vid.addEventListener("ended", () => { playing = false; report(); if (W.confirm) unlockConfirm(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) report(); });
    window.addEventListener("pagehide", report);

    function report() {
      if (!viewId) return;
      lastSent = Date.now();
      const body = JSON.stringify({ kind: "progress", view: viewId, buckets: buckets.join("") });
      if (navigator.sendBeacon) navigator.sendBeacon("/e/" + W.token, new Blob([body], { type: "application/json" }));
      else send(JSON.parse(body));
    }
  }

  // ---- "watch and confirm" (e.g. house rules), then reveal the hidden text
  function unlockConfirm() {
    const b = document.getElementById("confirm");
    if (b && b.disabled) { b.disabled = false; document.getElementById("confirmhint").textContent = "Thanks for watching. Please confirm:"; }
  }
  const confirmBtn = document.getElementById("confirm");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      const r = await send({ kind: "confirm" });
      confirmBtn.innerHTML = "&#10004; Confirmed";
      const box = document.getElementById("reveal");
      if (r.reveal) { box.textContent = r.reveal; box.hidden = false; }
    });
  }

  // ---- approve / decline
  ["approve", "decline"].forEach((kind) => {
    const b = document.getElementById(kind);
    if (!b) return;
    b.addEventListener("click", async () => {
      document.getElementById("approve").disabled = true;
      document.getElementById("decline").disabled = true;
      await send({ kind, text: document.getElementById("approvenote").value.trim() });
      const ok = document.getElementById("approveok");
      ok.textContent = kind === "approve" ? "Approved. Thank you, we've been notified." : "Declined. We've been notified.";
      ok.hidden = false;
    });
  });

  // ---- captions in the viewer's own language (Chrome's built-in translator, free, on their device)
  (async () => {
    const lang = (navigator.language || "en").slice(0, 2);
    if (!vid || lang === "en" || !("Translator" in self)) return;
    try {
      const avail = await Translator.availability({ sourceLanguage: "en", targetLanguage: lang });
      if (avail === "unavailable") return;
      const tr = await Translator.create({ sourceLanguage: "en", targetLanguage: lang });
      const track = vid.textTracks[0];
      if (!track) return;
      track.mode = "hidden";
      await new Promise((r) => setTimeout(r, 500));
      const cues = [...(track.cues || [])];
      if (!cues.length) return;
      const t2 = vid.addTextTrack("captions", lang, lang);
      for (const c of cues) t2.addCue(new VTTCue(c.startTime, c.endTime, await tr.translate(c.text)));
      t2.mode = "showing";
    } catch (e) { /* captions stay in English */ }
  })();

  // ---- button, like, reply
  const cta = document.getElementById("cta");
  if (cta) cta.addEventListener("click", () => { send({ kind: "click", text: W.cta }); });
  const like = document.getElementById("like");
  if (like) like.addEventListener("click", () => {
    if (like.classList.contains("on")) return;
    like.classList.add("on");
    like.innerHTML = "&#128077; Liked";
    send({ kind: "like" });
  });
  const replyForm = document.getElementById("reply");
  if (replyForm) replyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const box = document.getElementById("replytext");
    if (!box.value.trim()) return;
    await send({ kind: "comment", text: box.value.trim() });
    box.value = "";
    document.getElementById("replyok").hidden = false;
  });
})();

// ---- chapters, read-along text, and questions / polls / star ratings
(function () {
  const W = window.WATCH;
  const vid = document.getElementById("vid");
  const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const post = (body) => {
    const h = { "Content-Type": "application/json" };
    try { const k = localStorage.getItem("ss_session"); if (k) h["X-Session"] = k; } catch (e) {}
    return fetch("/e/" + W.token, { method: "POST", headers: h, body: JSON.stringify(body), credentials: "same-origin" });
  };

  // Chapters: tap to jump.
  const chapBox = document.getElementById("chapters");
  if (chapBox && vid) {
    chapBox.innerHTML = W.chapters.map((c, i) => `<button data-i="${i}"><b>${fmt(c.t)}</b>${esc(c.title)}</button>`).join("");
    chapBox.querySelectorAll("button").forEach((b) => b.onclick = () => { vid.currentTime = W.chapters[b.dataset.i].t; vid.play(); });
    vid.addEventListener("timeupdate", () => {
      let cur = -1;
      W.chapters.forEach((c, i) => { if (vid.currentTime >= c.t) cur = i; });
      chapBox.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === cur));
    });
  }

  // Read along: the captions as text; tap a line to jump there.
  const tbox = document.getElementById("transcript");
  if (tbox && vid) {
    fetch("/m/" + W.token + "/captions.vtt").then((r) => r.text()).then((vtt) => {
      const cues = [];
      vtt.split(/\n\n+/).forEach((block) => {
        const m = block.match(/(\d+):(\d+):(\d+)[.,](\d+)\s+-->\s+(\d+):(\d+):(\d+)/);
        if (!m) return;
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
        const text = block.split("\n").filter((l) => l && !l.includes("-->") && !/^\d+$/.test(l)).join(" ");
        cues.push({ t, text });
      });
      tbox.innerHTML = cues.map((c, i) => `<p data-i="${i}"><span>${fmt(c.t)}</span>${esc(c.text)}</p>`).join("");
      tbox.querySelectorAll("p").forEach((p) => p.onclick = () => { vid.currentTime = cues[p.dataset.i].t; vid.play(); });
      vid.addEventListener("timeupdate", () => {
        let cur = -1;
        cues.forEach((c, i) => { if (vid.currentTime >= c.t) cur = i; });
        tbox.querySelectorAll("p").forEach((p, i) => p.classList.toggle("on", i === cur));
      });
    }).catch(() => {});
  }

  // Questions: ones with a time pause the video there; the rest appear at the end.
  const qs = W.questions || [];
  if (!qs.length) return;
  const done = new Set();
  const lay = document.getElementById("quizlay"), endBox = document.getElementById("quiz");

  function card(q, onDone) {
    const wrap = document.createElement("div");
    wrap.className = "qcard";
    let body = "";
    if (q.type === "rating") body = `<div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-a="${n}" aria-label="${n} stars">&#9733;</button>`).join("")}</div>`;
    else if (q.type === "choice") body = `<div class="qopts">${q.options.map((o) => `<button data-a="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
    else body = `<textarea rows="3" maxlength="1000" placeholder="Type your answer"></textarea><button class="primary" data-text="1" style="margin-top:8px">Send</button>`;
    wrap.innerHTML = `<h3>${esc(q.q)}</h3>${body}<button class="qskip">Skip</button>`;
    const finish = async (a) => {
      if (a !== undefined) {
        try { await post({ kind: "answer", id: q.id, a }); } catch (e) {}
        wrap.innerHTML = `<h3>Thank you!</h3>`;
        setTimeout(() => onDone(), 900);
      } else onDone();
    };
    wrap.querySelectorAll("[data-a]").forEach((b) => {
      b.onclick = () => finish(q.type === "rating" ? Number(b.dataset.a) : b.dataset.a);
      if (q.type === "rating") b.onmouseenter = () => wrap.querySelectorAll(".stars button").forEach((s) => s.classList.toggle("lit", +s.dataset.a <= +b.dataset.a));
    });
    const tb = wrap.querySelector("[data-text]");
    if (tb) tb.onclick = () => { const v = wrap.querySelector("textarea").value.trim(); if (v) finish(v); };
    wrap.querySelector(".qskip").onclick = () => finish(undefined);
    return wrap;
  }

  function showEndQuestions() {
    const rest = qs.filter((q) => (q.t === null || q.t === undefined || !vid) && !done.has(q.id));
    if (!rest.length || !endBox) return;
    endBox.hidden = false;
    const next = () => {
      const q = rest.find((x) => !done.has(x.id));
      endBox.innerHTML = "";
      if (!q) { endBox.hidden = true; return; }
      done.add(q.id);
      endBox.appendChild(card(q, next));
    };
    next();
  }

  if (vid && lay) {
    vid.addEventListener("timeupdate", () => {
      if (!lay.hidden) return;
      const q = qs.find((x) => x.t !== null && x.t !== undefined && !done.has(x.id) && vid.currentTime >= x.t && vid.currentTime < x.t + 2);
      if (!q) return;
      done.add(q.id);
      vid.pause();
      lay.innerHTML = "";
      lay.appendChild(card(q, () => { lay.hidden = true; vid.play(); }));
      lay.hidden = false;
    });
    vid.addEventListener("ended", showEndQuestions);
    // A trimmed video stops before its real end, so "ended" never fires.
    vid.addEventListener("pause", () => { if (W.trimEnd && vid.currentTime >= W.trimEnd - 0.3) showEndQuestions(); });
  } else {
    showEndQuestions(); // a screenshot: ask straight away
  }
})();
