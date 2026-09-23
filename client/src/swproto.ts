// Messages between the Service Worker (sw.ts) and the page bridge (page.ts).
//
// The Service Worker only intercepts. Every forwarded request is answered by
// the HTTP4 session of the tab that made it, so the session lives as long as
// the tab, not as long as the worker (vrek dec-sf6t0g6, fnd-f844ews).
//
//   SW → page  { http4: "hello" } + port   "can you serve my requests?"
//     page → SW on that port: { state: "connecting" } at once, then
//     { state: "ready", ... } when its session is up (or known unavailable)
//   SW → page  { http4: "serve", url, method } + port
//     page → SW on that port: a ServeReply, with the body transferred (a
//     streaming body is itself a transferred ReadableStream, so the worker's
//     Response streams on to the page as the transfer arrives)
//   page → SW  { http4: "report", all? } + port
//     SW → page on that port: SwRequestReport[]
//   SW → page  { http4: "log", entry }   (no port)
//     every report entry, as it is recorded, so the tab keeps its own copy
//     that survives Chrome stopping the idle worker (fnd-f844ews)

import type { Http4Outcome, Transport } from "./fetcher.ts";

/** Where the Service Worker script is served: the site root, so its scope is the whole site. */
export const SW_URL = "/http4-sw.js";
/** Everything else client-side is served under this path; the worker never forwards it. */
export const CLIENT_DIR = "/http4/";
/** Paths the worker always leaves to the network, whatever the asset prefix. */
export const BOOTSTRAP_PATHS = [SW_URL, "/config.json"];

export interface HelloMsg {
  http4: "hello";
}

export interface ServeMsg {
  http4: "serve";
  url: string;
  method: "GET" | "HEAD";
  /**
   * Request.destination ("style", "script", "image", "" for fetch/XHR, …).
   * The worker knows it and the page does not, so it has to travel with the
   * request for the page to classify it (vrek iss-j9tm9w8).
   */
  destination?: string;
}

export interface ReportMsg {
  http4: "report";
  /** Every client's requests, not only the asking tab's. */
  all?: boolean;
}

export interface LogMsg {
  http4: "log";
  entry: SwRequestReport;
}

export type SwMessage = HelloMsg | ServeMsg | ReportMsg | LogMsg;

export type HelloReply =
  | { state: "connecting" }
  | {
      state: "ready";
      /** Whether this tab's HTTP4 session is open. */
      available: boolean;
      reason?: string;
      /** Only paths under this prefix are forwarded; null means the page decides for every path. */
      assetPrefix: string | null;
    };

/**
 * Http4Outcome with its body in a form postMessage can transfer: a whole
 * ArrayBuffer, or a ReadableStream while the transfer is still arriving.
 */
export type ServeReply =
  | {
      transport: "http4";
      status: number;
      headers: [string, string][];
      body: ArrayBuffer | null;
      stream?: ReadableStream<Uint8Array>;
      /** Declared body length, for the worker's report, when `stream` is set. */
      length?: number;
    }
  | { transport: "fallback" | "platform"; reason: string };

/** One request the worker saw, and how it was served. */
export interface SwRequestReport {
  url: string;
  method: string;
  /** Request.destination: "image", "style", "script", "font", "" for fetch(), … */
  destination: string;
  transport: Transport;
  reason?: string;
  status: number;
  ms: number;
  bytes: number | null;
  /** The tab (Client.id) the request came from. */
  clientId: string;
}

/** A ServeReply for an outcome. The body's buffer is transferred when it is the whole buffer, else copied. */
export function serveReply(o: Http4Outcome): { reply: ServeReply; transfer: Transferable[] } {
  if (o.transport !== "http4") return { reply: o, transfer: [] };
  if (o.stream) {
    const { status, headers, length } = o;
    return { reply: { transport: "http4", status, headers, body: null, stream: o.stream, ...(length !== undefined ? { length } : {}) }, transfer: [o.stream] };
  }
  let body: ArrayBuffer | null = null;
  if (o.body) {
    const whole = o.body.byteOffset === 0 && o.body.byteLength === o.body.buffer.byteLength;
    body = whole ? o.body.buffer : o.body.slice().buffer;
  }
  return { reply: { ...o, body, stream: undefined }, transfer: body ? [body] : [] };
}

/** The parts of a FetchEvent the interception decision looks at. */
export interface InterceptInput {
  url: string;
  method: string;
  mode: string; // Request.mode; "navigate" for page loads
  hasRange: boolean;
  clientId: string; // FetchEvent.clientId; "" when there is no client (e.g. navigations)
}

/**
 * Why the worker leaves a request to the network untouched, or null to
 * forward it to its tab. Pure, so it can be tested without a worker.
 */
export function leaveToNetwork(r: InterceptInput, origin: string): string | null {
  if (r.mode === "navigate") return "navigation";
  if (r.method !== "GET" && r.method !== "HEAD") return `method ${r.method}`;
  const url = new URL(r.url);
  if (url.origin !== origin) return "cross-origin";
  if (url.pathname.startsWith(CLIENT_DIR) || BOOTSTRAP_PATHS.includes(url.pathname)) return "HTTP4 bootstrap file";
  if (r.hasRange) return "range request";
  if (!r.clientId) return "no client";
  return null;
}

/**
 * How long a request waits for its tab's HTTP4 session before giving up and
 * using the network, by what the request is for.
 *
 * Holding is a bet, and an asymmetric one. Nothing has been requested yet, so
 * a hold that ends in fallback costs exactly its own length — but a hold that
 * pays off puts the bytes under the scheduler, which is the whole point. The
 * wait also usually ends early, when the tab's connect attempt resolves either
 * way (ConnectOptions.connectTimeoutMs, 5 s by default), so these are caps on
 * a wait rather than delays that are actually spent.
 *
 * The split follows what is waiting on the bytes:
 *   - A stylesheet or script blocks rendering, so every millisecond held is a
 *     millisecond of first paint. Barely wait.
 *   - Images and media block nothing, arrive in bulk, and are exactly what
 *     SRPT exists to order. On a slow link they are also the requests the
 *     browser dispatches earliest and the session misses (vrek fnd-sgw2sbh),
 *     so this is where a longer wait buys the most.
 *
 * Pure, so it can be tested without a worker.
 */
export const READY_TIMEOUT_MS = 2000;
export const READY_TIMEOUT_BLOCKING_MS = 400;
export const READY_TIMEOUT_BULK_MS = 6000;

export function readyTimeoutMs(destination: string): number {
  switch (destination) {
    case "style":
    case "script":
      return READY_TIMEOUT_BLOCKING_MS;
    case "image":
    case "video":
    case "audio":
      return READY_TIMEOUT_BULK_MS;
    default:
      // "font" (text is already laid out), "" for fetch()/XHR (the app is
      // running, so a session is normally up), and anything new.
      return READY_TIMEOUT_MS;
  }
}

/** Recognises one of our messages, ignoring anything else posted to the same context. */
export function isSwMessage(m: unknown): m is SwMessage {
  return typeof m === "object" && m !== null && typeof (m as { http4?: unknown }).http4 === "string";
}
