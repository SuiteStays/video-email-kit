self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Android: a video shared from the gallery to "__COMPANY__ Video" arrives here.
// Keep it for the program to upload in pieces, then open the program.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/share-target") return;
  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      const file = form.get("video");
      if (file && file.size) {
        const cache = await caches.open("ss-share");
        await cache.put("/shared-video", new Response(file, {
          headers: { "content-type": file.type || "video/mp4", "x-filename": encodeURIComponent(file.name || "Shared video.mp4") },
        }));
      }
    } catch (e) { /* fall through to the program */ }
    return Response.redirect("/app#/shared", 303);
  })());
});

// Shows alerts on phones and computers, even when the program isn't open.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || "__COMPANY__ Video", {
    body: data.body || "",
    icon: "/static/icon-192.png",
    badge: "/static/icon-192.png",
    data: { url: data.url || "/app" },
    tag: undefined,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/app";
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.includes("/app")) { await w.focus(); return w.navigate(url); }
    }
    return clients.openWindow(url);
  })());
});
