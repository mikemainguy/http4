// The HTTP4 Service Worker, served at the site root as /http4-sw.js.
//
// It owns no HTTP4 session. Each same-origin subresource request is
// forwarded to the tab that made it (FetchEvent.clientId), whose page bridge
// (page.ts) answers from that tab's own session. So the session outlives this
// worker, which Chrome stops after ~30 s idle (vrek dec-sf6t0g6, fnd-f844ews).
// Anything the page can't serve goes to the network: navigations, tabs
// without the bridge (for example on the first visit, fnd-hnymjv8), sessions
// that are down, and failed transfers.

import {
  isSwMessage, leaveToNetwork, type HelloReply, type ServeMsg, type ServeReply, type SwRequestReport,
} from "./swproto.ts";
import type { Transport } from "./fetcher.ts";

// The DOM lib has no Service Worker global types, so declare what's used.
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  readonly clientId: string;
  respondWith(r: Response | Promise<Response>): void;
}
interface SwClient {
  readonly id: string;
  postMessage(message: unknown, transfer: Transferable[]): void;
}
interface SwGlobal {
  readonly location: Location;
  readonly clients: { get(id: string): Promise<SwClient | undefined>; claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", l: (e: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", l: (e: FetchEvent) => void): void;
  addEventListener(type: "message", l: (e: MessageEvent) => void): void;
}
const sw = self as unknown as SwGlobal;

/** How long a tab has to answer "hello" before it counts as having no bridge. */
const ACK_TIMEOUT_MS = 500;
/** How long a request waits for the tab's session to come up before using the network. */
const READY_TIMEOUT_MS = 2000;
/** How often a forwarded request checks that its tab still exists. */
const WATCHDOG_MS = 1000;
const REPORT_LIMIT = 2000;

type Ready = Extract<HelloReply, { state: "ready" }>;

interface TabState {
  /** Resolves true when the tab answered hello, false after ACK_TIMEOUT_MS. */
  acked: Promise<boolean>;
  ready: Promise<Ready>;
  info?: Ready;
}

const tabs = new Map<string, TabState>();
const log: SwRequestReport[] = [];

sw.addEventListener("install", (e) => e.waitUntil(sw.skipWaiting()));
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));

sw.addEventListener("fetch", (e) => {
  const req = e.request;
  const skip = leaveToNetwork(
    { url: req.url, method: req.method, mode: req.mode, hasRange: req.headers.has("range"), clientId: e.clientId },
    sw.location.origin,
  );
  if (skip) {
    // Not calling respondWith() lets the browser fetch it as if there were no worker.
    record(req, e.clientId, "platform", 0, null, 0, skip);
    return;
  }
  e.respondWith(serve(req, e.clientId));
});

sw.addEventListener("message", (e) => {
  const m: unknown = e.data;
  const port = e.ports[0];
  if (!isSwMessage(m) || m.http4 !== "report" || !port) return;
  const from = (e.source as SwClient | null)?.id;
  port.postMessage(m.all ? log.slice() : log.filter((r) => r.clientId === from));
});

async function serve(req: Request, clientId: string): Promise<Response> {
  const t0 = performance.now();
  const network = async (transport: Transport, reason: string) => {
    const res = await fetch(req);
    const len = res.headers.get("content-length");
    record(req, clientId, transport, res.status, len === null ? null : Number(len), performance.now() - t0, reason);
    return res;
  };

  const client = await sw.clients.get(clientId);
  if (!client) return network("fallback", "requesting tab not found");
  const tab = tabs.get(clientId) ?? hello(client);
  if (!tab.info) {
    if (!(await tab.acked)) return network("fallback", "tab has no HTTP4 bridge");
    const info = await Promise.race([tab.ready, sleep(READY_TIMEOUT_MS).then(() => undefined)]);
    if (!info) return network("fallback", "tab's HTTP4 session not ready");
  }
  const info = tab.info!;
  if (!info.available) return network("fallback", info.reason ?? "HTTP4 unavailable in tab");
  if (info.assetPrefix !== null && !new URL(req.url).pathname.startsWith(info.assetPrefix)) {
    return network("platform", "not an HTTP4 asset path");
  }

  let reply: ServeReply;
  try {
    reply = await forward(client, { http4: "serve", url: req.url, method: req.method as "GET" | "HEAD" });
  } catch (err) {
    return network("fallback", `forwarding failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (reply.transport !== "http4") return network(reply.transport, reply.reason);
  record(req, clientId, "http4", reply.status, reply.body?.byteLength ?? 0, performance.now() - t0);
  return new Response(reply.body, { status: reply.status, headers: reply.headers });
}

/** Ask a tab whether it can serve requests; remember its answer for the tab's lifetime. */
function hello(client: SwClient): TabState {
  const ch = new MessageChannel();
  let ack!: (v: boolean) => void;
  let ready!: (r: Ready) => void;
  const tab: TabState = {
    acked: new Promise((r) => (ack = r)),
    ready: new Promise((r) => (ready = r)),
  };
  ch.port1.onmessage = (e: MessageEvent<HelloReply>) => {
    ack(true);
    if (e.data.state === "ready") {
      tab.info = e.data;
      ready(e.data);
      ch.port1.close();
    }
  };
  setTimeout(() => ack(false), ACK_TIMEOUT_MS);
  client.postMessage({ http4: "hello" }, [ch.port2]);
  tabs.set(client.id, tab);
  return tab;
}

/** Send one request to the tab and wait for its reply, giving up if the tab goes away. */
function forward(client: SwClient, msg: ServeMsg): Promise<ServeReply> {
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const watchdog = setInterval(async () => {
      if (!(await sw.clients.get(client.id))) done(() => reject(new Error("tab closed")));
    }, WATCHDOG_MS);
    const done = (f: () => void) => {
      clearInterval(watchdog);
      ch.port1.close();
      f();
    };
    ch.port1.onmessage = (e: MessageEvent<ServeReply>) => done(() => resolve(e.data));
    client.postMessage(msg, [ch.port2]);
  });
}

function record(
  req: Request, clientId: string, transport: Transport, status: number, bytes: number | null, ms: number, reason?: string,
): void {
  const r: SwRequestReport = { url: req.url, method: req.method, destination: req.destination, transport, status, ms, bytes, clientId };
  if (reason !== undefined) r.reason = reason;
  log.push(r);
  if (log.length > REPORT_LIMIT) log.shift();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
