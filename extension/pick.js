// Small helper window for "Select an area (any monitor)".
// Chrome only shows its screen/window chooser when a real page asks for it (the
// background script can't), so this page asks, freezes one picture of what was
// picked, hands it to the background script, and closes.
const delay = Number(new URLSearchParams(location.search).get("delay") || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = document.getElementById("msg");
const again = document.getElementById("again");

async function frame(stream) {
  const c = document.createElement("canvas");
  try {
    const bmp = await new ImageCapture(stream.getVideoTracks()[0]).grabFrame();
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
  } catch (e) {
    const v = document.createElement("video");
    v.srcObject = stream; v.muted = true;
    await v.play();
    await sleep(250);
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
  }
  if (!c.width || !c.height) throw new Error("the screen picture came back empty");
  return { dataUrl: c.toDataURL("image/png"), width: c.width, height: c.height };
}

async function go() {
  again.hidden = true; msg.className = "";
  msg.innerHTML = "Pick the screen or window in the box that appears, then click <b>Share</b>.";
  const me = await chrome.windows.getCurrent();
  const streamId = await new Promise((resolve) => chrome.desktopCapture.chooseDesktopMedia(["screen", "window"], resolve));
  if (!streamId) { window.close(); return; } // closed the box without choosing
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId, maxWidth: 7680, maxHeight: 4320, maxFrameRate: 5 } },
    });
    // Get this little window out of the picture, then (optionally) wait so a
    // menu or pop-up can be opened first.
    await chrome.windows.update(me.id, { state: "minimized" });
    await sleep(700 + delay * 1000);
    const shot = await frame(stream);
    stream.getTracks().forEach((t) => t.stop()); stream = null;
    const res = await chrome.runtime.sendMessage({ type: "snip-shot", shot });
    if (res && res.error) throw new Error(res.error);
    window.close();
  } catch (e) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    try { await chrome.windows.update(me.id, { state: "normal", focused: true }); } catch (_) {}
    msg.className = "err";
    msg.textContent = "The screenshot didn't work: " + ((e && e.message) || e);
    again.hidden = false;
  }
}
again.onclick = go;
go();
