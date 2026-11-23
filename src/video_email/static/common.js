// Some phone browsers throw away the sign-in cookie. The program keeps its
// own copy of the sign-in key and sends it with every request to this site.
(function () {
  const get = (k) => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } };
  const original = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const key = get("ss_session");
    const sameSite = url.startsWith("/") || url.startsWith(location.origin);
    if (key && sameSite && !(init.headers && (init.headers["X-Session"] || (init.headers.get && init.headers.get("X-Session"))))) {
      const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
      headers.set("X-Session", key);
      init = { ...init, headers };
    }
    return original(input, init);
  };
})();

// Helpers shared by the staff app and the "record a video for us" page.
window.SS = (function () {
  // Best recording format this browser supports. MP4 first: it plays
  // everywhere, including iPhones, with no converting on the server.
  function pickMime() {
    const options = [
      "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
      "video/mp4;codecs=avc1,mp4a",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    if (!window.MediaRecorder) return "";
    return options.find((m) => MediaRecorder.isTypeSupported(m)) || "";
  }

  // Send a file in pieces (each well under Cloudflare's upload limit),
  // retrying a piece a few times before giving up.
  async function uploadInPieces(blob, urlForPiece, onProgress, startSeq = 0) {
    const size = 8 * 1024 * 1024;
    let seq = startSeq;
    for (let off = 0; off < blob.size; off += size, seq++) {
      const piece = blob.slice(off, off + size);
      await putWithRetry(urlForPiece(seq), piece);
      if (onProgress) onProgress(Math.min(1, (off + size) / blob.size));
    }
    return seq;
  }

  async function putWithRetry(url, body, tries = 5) {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url, { method: "PUT", body, credentials: "same-origin" });
        if (r.ok) return r;
        if (r.status < 500 && r.status !== 409) throw new Error(await r.text());
      } catch (e) {
        if (i === tries - 1) throw e;
      }
      await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
    }
    throw new Error("Upload failed");
  }

  // Grab one frame as a JPEG (for the thumbnail and text-message preview).
  function frameToJpeg(video, maxW = 1280) {
    const w = Math.min(maxW, video.videoWidth || 1280);
    const h = Math.round(w * ((video.videoHeight || 720) / (video.videoWidth || 1280)));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(video, 0, 0, w, h);
    return new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
  }

  function seek(video, t) {
    return new Promise((res) => {
      const done = () => { video.removeEventListener("seeked", done); res(); };
      video.addEventListener("seeked", done);
      video.currentTime = t;
    });
  }

  // Load a recorded blob into a <video> so it can be measured and seeked.
  // MediaRecorder files often report an unknown length until we seek far ahead.
  function loadBlob(video, blob) {
    return new Promise((res) => {
      video.src = URL.createObjectURL(blob);
      video.onloadedmetadata = async () => {
        if (!isFinite(video.duration)) {
          await seek(video, 1e7);
          await seek(video, 0);
        }
        res(video.duration);
      };
    });
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  // Remember (or forget) the sign-in key for cookie-less phone browsers.
  function keepSession(data) {
    try {
      if (data && data.session) localStorage.setItem("ss_session", data.session);
      if (data && data.media_key) localStorage.setItem("ss_media", data.media_key);
      if (data === null) { localStorage.removeItem("ss_session"); localStorage.removeItem("ss_media"); }
    } catch (e) { /* private mode: the cookie still works */ }
  }
  // Added to picture and video links inside the program, so they load on those phones too.
  function mk(sep = "?") {
    let k = "";
    try { k = localStorage.getItem("ss_media") || ""; } catch (e) {}
    return k ? sep + "mk=" + encodeURIComponent(k) : "";
  }

  return { pickMime, uploadInPieces, frameToJpeg, seek, loadBlob, fmtTime, keepSession, mk };
})();
