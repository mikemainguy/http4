// Spike worker (vrek iss-x6ess8x): can a page hand this worker a streaming
// body, and does a Response built from it stream on to the page?
//
// /stream/transfer  the page transfers a ReadableStream over postMessage
// /stream/chunks    the page posts chunks; the worker rebuilds the stream
// /stream/buffer    the page transfers one whole ArrayBuffer (today's path)

self.addEventListener("install", (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (!url.pathname.startsWith("/stream/")) return;
  e.respondWith(serve(url.pathname.slice("/stream/".length), e.clientId));
});

async function serve(mode, clientId) {
  const client = await self.clients.get(clientId);
  if (!client) return new Response("no client", { status: 503 });
  const ch = new MessageChannel();
  const first = new Promise((resolve) => (ch.port1.onmessage = (ev) => resolve(ev.data)));
  client.postMessage({ spike: "serve", mode }, [ch.port2]);
  const reply = await first;

  if (reply.kind === "stream") {
    // A transferred ReadableStream, used directly as the Response body.
    return new Response(reply.stream, { headers: { "content-type": "application/octet-stream" } });
  }
  if (reply.kind === "chunks") {
    // The page keeps posting on the same port; rebuild a stream from them.
    const body = new ReadableStream({
      start(controller) {
        ch.port1.onmessage = (ev) => {
          if (ev.data.done) {
            controller.close();
            ch.port1.close();
          } else {
            controller.enqueue(new Uint8Array(ev.data.chunk));
          }
        };
        ch.port1.postMessage({ go: true });
      },
    });
    return new Response(body, { headers: { "content-type": "application/octet-stream" } });
  }
  return new Response(reply.buffer, { headers: { "content-type": "application/octet-stream" } });
}
