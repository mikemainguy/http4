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

/** Continuous background load: `concurrency` downloads, each restarted as it finishes. */
export interface BackgroundSpec {
  stack: Stack;
  id: string;
  concurrency: number;
}

export interface BackgroundStats {
  completed: number;
  failed: number;
  aborted: number; // in flight when the load was stopped
  bytes: number; // completed downloads only
  seconds: number; // from start to stop
  errors: string[]; // first few distinct failures
}

/** One measured window of API-style requests arriving as a Poisson process. */
export interface ForegroundSpec {
  stack: Stack;
  ids: string[]; // cycled in order, one per arrival
  count: number;
  rateHz: number;
  seed: number;
  priority?: RequestPriority; // h3 only
}

export interface ForegroundStats {
  ms: number[]; // completion time per successful request
  issued: number;
  failed: number;
  bytes: number;
  seconds: number; // wall time of the window, generation plus drain
  errors: string[];
  protocols: Record<string, number>; // h3 only: nextHopProtocol tally for this window
}

export interface Bench {
  ready: Promise<void>;
  run(schedule: ScheduledRequest[], opts?: RunOptions): Promise<RequestResult[]>;
  startBackground(spec: BackgroundSpec): Promise<void>;
  stopBackground(): Promise<BackgroundStats>;
  foreground(spec: ForegroundSpec): Promise<ForegroundStats>;
  /** Close and reopen the HTTP4 session (drops any transfer still in flight). */
  resetHttp4(): Promise<void>;
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
    let url: string | undefined;
    if (req.stack === "h3") {
      // A unique query per request keeps Resource Timing entries unambiguous
      // (and caches out of the way); the server ignores the query.
      url = `${cfg.h3Url}${req.id.split("/").map(encodeURIComponent).join("/")}?run=${run}&i=${index}`;
      const r = await fetch(url, { cache: "no-store", ...(req.priority ? { priority: req.priority } : {}) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      body = await r.arrayBuffer();
    } else {
      body = (await http4.fetch(req.id)).buffer as ArrayBuffer;
    }
    // Stop the clock on the body, before any Resource Timing lookup: that
    // lookup polls on a 5 ms timer and only happens for h3, so timing it
    // would bias every comparison in HTTP4's favour.
    const end = performance.now() - t0;
    const protocol = url === undefined ? undefined : ((await timingEntry(url))?.nextHopProtocol ?? "no-timing-entry");
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

// ---------------------------------------------------------------------------
// Load generator for the G3 benchmark (vrek iss-3ecq28b): continuous
// background downloads plus API-style foreground requests, on one stack.

/** Fetch one asset and return its size, without hashing or timing lookups. */
async function fetchBytes(id: string, stack: Stack, opts: { priority?: RequestPriority; signal?: AbortSignal; tag: string }): Promise<number> {
  if (stack === "http4") return (await http4.fetch(id)).length;
  const url = `${cfg.h3Url}${id.split("/").map(encodeURIComponent).join("/")}?${opts.tag}=${++urlSeq}`;
  const r = await fetch(url, {
    cache: "no-store",
    ...(opts.priority ? { priority: opts.priority } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.arrayBuffer()).byteLength;
}

let urlSeq = 0;

interface BackgroundState extends BackgroundStats {
  spec: BackgroundSpec;
  stopping: boolean;
  abort: AbortController;
  loops: Promise<void>[];
  startedAt: number;
}
let background: BackgroundState | undefined;

function note(errors: string[], e: unknown): void {
  const s = String(e);
  if (errors.length < 5 && !errors.includes(s)) errors.push(s);
}

async function startBackground(spec: BackgroundSpec): Promise<void> {
  if (background) await stopBackground();
  const st: BackgroundState = {
    spec, stopping: false, abort: new AbortController(), loops: [], startedAt: performance.now(),
    completed: 0, failed: 0, aborted: 0, bytes: 0, seconds: 0, errors: [],
  };
  background = st;
  const loop = async () => {
    while (!st.stopping) {
      try {
        st.bytes += await fetchBytes(spec.id, spec.stack, { signal: st.abort.signal, tag: "bg" });
        st.completed++;
      } catch (e) {
        if (st.stopping) st.aborted++;
        else {
          st.failed++;
          note(st.errors, e);
          // A failing background download would otherwise spin; pace retries.
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }
  };
  for (let i = 0; i < spec.concurrency; i++) st.loops.push(loop());
}

async function stopBackground(): Promise<BackgroundStats> {
  const st = background;
  if (!st) return { completed: 0, failed: 0, aborted: 0, bytes: 0, seconds: 0, errors: [] };
  st.stopping = true;
  st.seconds = (performance.now() - st.startedAt) / 1000;
  // h3 downloads can be aborted; HTTP4 has no cancel, so the session is
  // dropped instead, which rejects whatever is still in flight.
  st.abort.abort();
  if (st.spec.stack === "http4") await resetHttp4();
  await Promise.all(st.loops);
  background = undefined;
  return { completed: st.completed, failed: st.failed, aborted: st.aborted, bytes: st.bytes, seconds: st.seconds, errors: st.errors };
}

async function resetHttp4(): Promise<void> {
  http4.close();
  http4 = await Http4Client.connect(cfg.webTransportUrl, base64ToBytes(cfg.certHash));
}

/** Deterministic exponential interarrival times: a Poisson process at rateHz. */
function arrivals(count: number, rateHz: number, seed: number): number[] {
  let s = seed >>> 0;
  const next = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    t += -Math.log(1 - next() * 0.999999) / (rateHz / 1000); // ms
    out.push(t);
  }
  return out;
}

async function foreground(spec: ForegroundSpec): Promise<ForegroundStats> {
  const times = arrivals(spec.count, spec.rateHz, spec.seed);
  const ms: number[] = [];
  const errors: string[] = [];
  let failed = 0;
  let bytes = 0;
  const t0 = performance.now();
  const windowStart = t0;

  await Promise.all(
    times.map(
      (at, i) =>
        new Promise<void>((resolve) => {
          const go = async () => {
            const id = spec.ids[i % spec.ids.length]!;
            const started = performance.now();
            try {
              const n = await fetchBytes(id, spec.stack, { ...(spec.priority ? { priority: spec.priority } : {}), tag: "fg" });
              ms.push(performance.now() - started);
              bytes += n;
            } catch (e) {
              failed++;
              note(errors, e);
            }
            resolve();
          };
          const delay = at - (performance.now() - t0);
          if (delay <= 0) void go();
          else setTimeout(() => void go(), delay);
        }),
    ),
  );

  // Protocol tally for this window only, read once at the end so the lookup
  // never lands inside a measured request.
  const protocols: Record<string, number> = {};
  if (spec.stack === "h3") {
    for (const e of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
      if (e.startTime >= windowStart && e.name.startsWith(cfg.h3Url) && e.name.includes("fg=")) {
        protocols[e.nextHopProtocol || "unknown"] = (protocols[e.nextHopProtocol || "unknown"] ?? 0) + 1;
      }
    }
  }
  return { ms, issued: times.length, failed, bytes, seconds: (performance.now() - t0) / 1000, errors, protocols };
}

const status = document.getElementById("status")!;
const ready = init().then(
  () => void (status.textContent = "ready"),
  (e) => {
    status.textContent = `init failed: ${e}`;
    throw e;
  },
);
window.__bench = { ready, run, startBackground, stopBackground, foreground, resetHttp4 };
