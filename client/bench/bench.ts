// Benchmark page: runs a schedule of asset requests over HTTP4 and over plain
// HTTP/3 in the same browser, against the same server, port and certificate,
// and records per-request timings. It is the shared harness for the G3/G4
// benchmarks (vrek iss-3ecq28b, iss-fx41xz5); those supply the schedules.
//
// Drive it from a test through window.__bench:
//   await window.__bench.ready;
//   const results = await window.__bench.run([{ at: 0, id: "api.json", stack: "h3" }, ...]);
//
// HTTP/3 needs Chrome launched with --origin-to-force-quic-on and
// --ignore-certificate-errors-spki-list (tests/support/harness.ts, `h3`).
// run() throws if any baseline request did not actually use h3, because a
// silent fallback to TCP would make every comparison meaningless.

import { Http4Client } from "../src/transport.ts";

interface BenchConfig {
  webTransportUrl: string;
  certHash: string;
  h3Url: string;
}

export type Stack = "h3" | "http4";

export interface ScheduledRequest {
  at: number; // ms after run() starts
  id: string; // asset ID
  stack: Stack;
  priority?: RequestPriority; // h3 only: fetch()'s priority hint
  tag?: string; // free-form label carried into the result, e.g. "api" / "background"
}

export interface RequestResult {
  index: number; // position in the schedule
  id: string;
  stack: Stack;
  priority?: RequestPriority;
  tag?: string;
  at: number;
  start: number; // ms after run() start, when the request was issued
  end: number; // when the whole body was available
  ms: number; // end - start
  bytes: number;
  sha256?: string;
  protocol?: string; // h3 only: Resource Timing nextHopProtocol
  ok: boolean;
  error?: string;
}

export interface RunOptions {
  hash?: boolean; // compute SHA-256 of each body (default true)
  allowNonH3?: boolean; // don't throw when an h3 request used another protocol
}

export interface Bench {
  ready: Promise<void>;
  run(schedule: ScheduledRequest[], opts?: RunOptions): Promise<RequestResult[]>;
}

declare global {
  interface Window {
    __bench?: Bench;
  }
}

const base64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

let cfg: BenchConfig;
let http4: Http4Client;
let runSeq = 0;

async function init(): Promise<void> {
  const res = await fetch("/config.json", { cache: "no-store" });
  cfg = (await res.json()) as BenchConfig;
  http4 = await Http4Client.connect(cfg.webTransportUrl, base64ToBytes(cfg.certHash));
  // Default buffer is 250 entries; a benchmark run can issue thousands.
  performance.setResourceTimingBufferSize(1_000_000);
}

/** The Resource Timing entry for url; it can land a moment after the body. */
async function timingEntry(url: string): Promise<PerformanceResourceTiming | undefined> {
  for (let i = 0; i < 20; i++) {
    const e = performance.getEntriesByName(url, "resource")[0] as PerformanceResourceTiming | undefined;
    if (e) return e;
    await new Promise((r) => setTimeout(r, 5));
  }
  return undefined;
}

async function one(req: ScheduledRequest, index: number, t0: number, run: number, hash: boolean): Promise<RequestResult> {
  const base = { index, id: req.id, stack: req.stack, at: req.at, ...(req.priority ? { priority: req.priority } : {}), ...(req.tag ? { tag: req.tag } : {}) };
  const start = performance.now() - t0;
  try {
    let body: ArrayBuffer;
    let protocol: string | undefined;
    if (req.stack === "h3") {
      // A unique query per request keeps Resource Timing entries unambiguous
      // (and caches out of the way); the server ignores the query.
      const url = `${cfg.h3Url}${req.id.split("/").map(encodeURIComponent).join("/")}?run=${run}&i=${index}`;
      const r = await fetch(url, { cache: "no-store", ...(req.priority ? { priority: req.priority } : {}) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      body = await r.arrayBuffer();
      protocol = (await timingEntry(url))?.nextHopProtocol ?? "no-timing-entry";
    } else {
      body = (await http4.fetch(req.id)).buffer as ArrayBuffer;
    }
    const end = performance.now() - t0;
    return {
      ...base, start, end, ms: end - start, bytes: body.byteLength, ok: true,
      ...(hash ? { sha256: hex(await crypto.subtle.digest("SHA-256", body)) } : {}),
      ...(protocol !== undefined ? { protocol } : {}),
    };
  } catch (e) {
    const end = performance.now() - t0;
    return { ...base, start, end, ms: end - start, bytes: 0, ok: false, error: String(e) };
  }
}

async function run(schedule: ScheduledRequest[], opts: RunOptions = {}): Promise<RequestResult[]> {
  const hash = opts.hash ?? true;
  const r = ++runSeq;
  performance.clearResourceTimings();
  const t0 = performance.now();
  const results = await Promise.all(
    schedule.map(
      (req, i) =>
        new Promise<RequestResult>((resolve) => {
          const go = () => resolve(one(req, i, t0, r, hash));
          if (req.at <= 0) go();
          else setTimeout(go, Math.max(0, req.at - (performance.now() - t0)));
        }),
    ),
  );
  if (!opts.allowNonH3) {
    const bad = results.filter((x) => x.stack === "h3" && x.ok && x.protocol !== "h3");
    if (bad.length > 0) {
      throw new Error(`${bad.length} baseline request(s) did not use HTTP/3: ${bad.slice(0, 5).map((x) => `${x.id}=${x.protocol}`).join(", ")}`);
    }
  }
  return results;
}

const status = document.getElementById("status")!;
const ready = init().then(
  () => void (status.textContent = "ready"),
  (e) => {
    status.textContent = `init failed: ${e}`;
    throw e;
  },
);
window.__bench = { ready, run };
