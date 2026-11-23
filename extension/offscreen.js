// Hidden helper page: turns the screen the person picked into one still picture.
// (The background script can't use the camera/screen APIs itself.)
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== "offscreen-grab") return;
  grab(msg.streamId).then(reply, (e) => reply({ error: e.message || String(e) }));
  return true; // answer comes later
});

async function grab(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId, maxWidth: 7680, maxHeight: 4320, maxFrameRate: 5 } },
  });
  try {
    const v = document.createElement("video");
    v.srcObject = stream; v.muted = true;
    await v.play();
    await new Promise((r) => setTimeout(r, 250)); // first frame can be black
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    return { dataUrl: c.toDataURL("image/png"), width: c.width, height: c.height };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
