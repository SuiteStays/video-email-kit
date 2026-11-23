// "Record a video for us": a guest, cleaner or owner records on their phone
// or computer (or picks a video they already have) and sends it. No account.
(function () {
  const R = window.REQ;
  const $ = (id) => document.getElementById(id);
  let stream = null, recorder = null, chunks = [], blob = null, facing = "environment", timerInt = null;

  const show = (id) => {
    ["step1", "recorder", "review", "progress", "done"].forEach((x) => { $(x).hidden = x !== id; });
  };
  const fail = (msg) => { $("err").textContent = msg; };
  const needName = () => {
    if (!$("rname").value.trim()) { fail("Please type your name first."); $("rname").focus(); return true; }
    fail(""); return false;
  };

  async function openCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
    $("live").srcObject = stream;
  }

  $("recbtn").addEventListener("click", async () => {
    if (needName()) return;
    if (!SS.pickMime()) { fail("This browser can't record. Use \"Choose a video\" instead."); return; }
    try { await openCamera(); show("recorder"); }
    catch (e) { fail("We couldn't open your camera. Allow camera access, or use \"Choose a video\"."); }
  });
  $("flip").addEventListener("click", async () => {
    facing = facing === "environment" ? "user" : "environment";
    try { await openCamera(); } catch (e) { /* only one camera */ }
  });
  $("startstop").addEventListener("click", () => {
    if (recorder && recorder.state === "recording") { recorder.stop(); return; }
    chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: SS.pickMime(), videoBitsPerSecond: 2500000 });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      clearInterval(timerInt);
      blob = new Blob(chunks, { type: recorder.mimeType.split(";")[0] });
      stream.getTracks().forEach((t) => t.stop());
      $("playback").src = URL.createObjectURL(blob);
      $("startstop").textContent = "Start recording";
      show("review");
    };
    recorder.start(1000);
    const t0 = Date.now();
    $("startstop").textContent = "Stop";
    timerInt = setInterval(() => { $("timer").textContent = "● " + SS.fmtTime((Date.now() - t0) / 1000); }, 500);
  });
  $("redo").addEventListener("click", async () => {
    blob = null; $("timer").textContent = "";
    try { await openCamera(); show("recorder"); } catch (e) { show("step1"); }
  });
  $("file").addEventListener("change", () => {
    const f = $("file").files[0];
    if (!f) return;
    if (needName()) { $("file").value = ""; return; }
    blob = f;
    $("playback").src = URL.createObjectURL(f);
    show("review");
  });

  $("send").addEventListener("click", async () => {
    if (!blob) return;
    show("progress");
    try {
      const pb = $("playback");
      let duration = 0, thumb = null;
      try {
        duration = await SS.loadBlob(pb, blob);
        await SS.seek(pb, Math.min(1, (duration || 2) / 2));
        thumb = await SS.frameToJpeg(pb);
      } catch (e) { /* preview frame is a nice-to-have */ }
      const start = await fetch("/r/" + R.token + "/start", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: $("rname").value.trim(), note: $("rnote").value.trim(), mime: blob.type || "video/mp4",
          consent: !!($("consent") && $("consent").checked) }) });
      if (!start.ok) throw new Error((await start.json()).detail || "Could not start");
      const { id, key } = await start.json();
      const q = "?key=" + encodeURIComponent(key);
      await SS.uploadInPieces(blob, (seq) => "/r/" + R.token + "/chunk/" + id + q + "&seq=" + seq,
        (p) => { $("barfill").style.width = Math.round(p * 100) + "%"; });
      if (thumb) await fetch("/r/" + R.token + "/thumb/" + id + q, { method: "PUT", body: thumb });
      const fin = await fetch("/r/" + R.token + "/finish/" + id + q, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ duration: isFinite(duration) ? duration : 0 }) });
      if (!fin.ok) throw new Error("Could not finish");
      show("done");
    } catch (e) {
      show("review");
      fail("Sending failed: " + e.message + ". Check your connection and press Send again.");
    }
  });
})();
