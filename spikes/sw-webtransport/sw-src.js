// Spike: can a Service Worker serve a page's subresources over HTTP4?
import { Http4Client } from "../../client/src/transport.ts";

const startedAt = Date.now(); // changes if Chrome terminates and restarts the worker
const log = [];
let clientP = null;
let connects = 0;
let lastConnectMs = null;
const TYPES = { png: "image/png", css: "text/css", js: "text/javascript", json: "application/json", bin: "application/octet-stream" };
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function connect() {
  const cfg = await (await fetch("/config.json", { cache: "no-store" })).json();
  const t0 = performance.now();
  const c = await Http4Client.connect(cfg.webTransportUrl, b64(cfg.certHash));
  connects++;
  lastConnectMs = performance.now() - t0;
  return c;
}
function client() {
  clientP ??= connect().catch((e) => {
    clientP = null;
    throw e;
  });
  return clientP;
}

self.addEventListener("install", (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith("/assets/")) return; // network as usual
  e.respondWith(serve(url, e.request.destination));
});

async function serve(url, dest) {
  const id = url.pathname.slice("/assets/".length);
  const t0 = performance.now();
  try {
    const bytes = await (await client()).fetch(id);
    const headers = { "x-served-by": "http4" };
    // noctype.js deliberately gets no Content-Type, to see what strict MIME checking does.
    if (id !== "noctype.js") headers["content-type"] = TYPES[id.split(".").pop()] ?? "application/octet-stream";
    log.push({ path: url.pathname, dest, via: "http4", ms: +(performance.now() - t0).toFixed(1), bytes: bytes.length });
    return new Response(bytes, { status: 200, headers });
  } catch (err) {
    clientP = null;
    log.push({ path: url.pathname, dest, via: "error", error: String(err) });
    return new Response("http4 failed: " + err, { status: 502 });
  }
}

self.addEventListener("message", (e) => {
  if (e.data === "report") {
    e.source.postMessage({ startedAt, connects, lastConnectMs, webTransportInSW: typeof WebTransport, log: log.splice(0) });
  }
});
