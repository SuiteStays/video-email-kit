// Toolbar button: record (in its own small window, so it keeps going while
// you work elsewhere), take a screenshot of this tab, or open the library.
const SERVER = "__SERVER__"; // filled in when the button is packaged
document.querySelectorAll("[data-go]").forEach((b) => {
  b.addEventListener("click", async () => {
    const url = SERVER + b.dataset.go;
    if (b.dataset.tab) await chrome.tabs.create({ url });
    else await chrome.windows.create({ url, type: "popup", width: 1000, height: 820 });
    window.close();
  });
});
document.querySelectorAll("[data-shot]").forEach((b) => {
  b.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.runtime.sendMessage({ type: "capture", mode: b.dataset.shot, tabId: tab.id });
    window.close(); // the capture carries on in the background
  });
});

// Off everywhere unless switched on here, one website at a time (e.g. your guest inbox).
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try { const u = new URL(tab.url); if (/^https?:$/.test(u.protocol) && u.origin !== SERVER && u.hostname !== "mail.google.com") host = u.hostname; } catch (e) {}
  if (!host) return;
  const { anyboxSites } = await chrome.storage.local.get({ anyboxSites: [] });
  const box = document.getElementById("siteToggle");
  document.getElementById("siteName").textContent = host;
  document.getElementById("siteRow").hidden = false;
  box.checked = anyboxSites.includes(host);
  box.onchange = async () => {
    const cur = (await chrome.storage.local.get({ anyboxSites: [] })).anyboxSites.filter((h) => h !== host);
    if (box.checked) cur.push(host);
    await chrome.storage.local.set({ anyboxSites: cur });
  };
})();
