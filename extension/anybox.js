// Optional "Video" button on message boxes - ONLY on websites you switch it on
// for (Chrome button > "Video button on this website"), e.g. a guest inbox.
// Even there it only appears on big multi-line message boxes, never on
// sign-in forms, search boxes or one-line fields.
(function () {
  const SERVER = "__SERVER__"; // filled in when the button is packaged
  if (location.origin === SERVER) return;
  let enabled = false, field = null, saved = null, btn = null;

  chrome.storage.local.get({ anyboxSites: [] }, (d) => { enabled = d.anyboxSites.includes(location.hostname); });
  chrome.storage.onChanged.addListener((ch) => {
    if (!ch.anyboxSites) return;
    enabled = (ch.anyboxSites.newValue || []).includes(location.hostname);
    if (!enabled && btn) btn.style.display = "none";
  });

  // A real message box: multi-line, reasonably big, and not on a sign-in page.
  const isMessageBox = (el) => {
    if (!el || document.querySelector('input[type="password"]')) return false;
    const multiLine = el.tagName === "TEXTAREA" || (el.isContentEditable && el.getAttribute("role") !== "combobox");
    if (!multiLine) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 280 && r.height >= 50;
  };

  function makeButton() {
    btn = document.createElement("div");
    btn.className = "ssv-anybox";
    btn.innerHTML = '<button type="button" class="ssv-go" title="Add a __COMPANY__ video"><span></span>Video</button>';
    btn.style.display = "none";
    document.documentElement.appendChild(btn);
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep the cursor where it was in the message
      if (field && field.isContentEditable) {
        const sel = getSelection();
        saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      } else if (field) saved = [field.selectionStart, field.selectionEnd];
    });
    btn.querySelector(".ssv-go").addEventListener("click", () => {
      window.open(SERVER + "/app#/pick?mode=text&origin=" + encodeURIComponent(location.origin), "ssvideo", "width=1080,height=780");
    });
  }

  function place() {
    if (!btn || !field || !document.contains(field)) { if (btn) btn.style.display = "none"; return; }
    const r = field.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) { btn.style.display = "none"; return; }
    btn.style.display = "flex";
    btn.style.top = Math.max(0, r.bottom - 34 + scrollY) + "px";
    btn.style.left = Math.max(0, r.right - btn.offsetWidth - 6 + scrollX) + "px";
  }
  document.addEventListener("focusin", (e) => {
    if (!enabled || !isMessageBox(e.target)) return;
    if (!btn) makeButton();
    field = e.target; place();
  });
  document.addEventListener("focusout", () => setTimeout(() => {
    if (btn && !btn.matches(":hover") && document.activeElement !== field) btn.style.display = "none";
  }, 200));
  addEventListener("scroll", place, true);
  addEventListener("resize", place);

  window.addEventListener("message", (e) => {
    if (e.origin !== SERVER || !e.data || e.data.type !== "ss-video-insert" || !field) return;
    const text = e.data.text || e.data.url;
    field.focus();
    if (field.isContentEditable) {
      const sel = getSelection();
      if (saved && field.contains(saved.startContainer)) { sel.removeAllRanges(); sel.addRange(saved); }
      document.execCommand("insertText", false, text);
    } else {
      const [a, b] = saved || [field.value.length, field.value.length];
      field.setRangeText(text, a ?? field.value.length, b ?? field.value.length, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
})();
