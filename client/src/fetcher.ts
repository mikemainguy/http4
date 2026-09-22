// The platform-fetch-shaped layer of the library: decides per request whether
// HTTP4 can serve it, builds a real Response from an HTTP4 transfer, falls
// back to the platform fetch otherwise, and records which transport served
// each request. No I/O of its own, so it can be tested with fakes.

import { Http4Error, httpStatusFor, type Http4Response } from "./transport.ts";
import { ErrorCode } from "./wire.ts";

/**
 * Which path served a request:
 * - `http4`: the HTTP4 session (including an authoritative 404 from it).
 * - `fallback`: eligible for HTTP4 but served by the platform fetch, because
 *   HTTP4 was unavailable or the transfer failed; `reason` says why.
 * - `platform`: not an HTTP4 request at all (cross-origin, POST, outside the
 *   asset prefix, a Range request…); `reason` says why.
 */
export type Transport = "http4" | "fallback" | "platform";

/** One request, as reported to `onRequest` and by `report()`. */
export interface RequestReport {
  url: string;
  method: string;
  transport: Transport;
  reason?: string;
  /** HTTP status of the returned Response; 0 if the platform fetch threw. */
  status: number;
  /** Time from the call to the Response being available (body included for HTTP4). */
  ms: number;
  /** Body bytes: exact for HTTP4, from Content-Length for the platform fetch, null if unknown. */
  bytes: number | null;
}

/** What the fetcher needs from an HTTP4 session. Http4Client provides it. */
export interface AssetRequester {
  readonly isOpen: boolean;
  request(assetId: string): Promise<Http4Response>;
}

export interface FetcherOptions {
  /** Base for relative URLs and the same-origin check, normally location.href. */
  baseUrl: string;
  /** Maps a request URL to an HTTP4 asset ID, or null to leave it to the platform fetch. */
  pathToAssetId: (url: URL) => string | null;
  platformFetch: typeof fetch;
  onRequest?: (r: RequestReport) => void;
  /** How many recent requests report() keeps (default 1000). */
  reportLimit?: number;
}

/**
 * The default asset mapping: same-origin URLs whose path starts with
 * `prefix` map to the percent-decoded remainder, which is the asset's path
 * inside the server's asset directory. The query string is ignored. Paths
 * with empty, "." or ".." segments are not mapped.
 */
export function prefixMapper(baseUrl: string, prefix: string): (url: URL) => string | null {
  const origin = new URL(baseUrl).origin;
  return (url) => {
    if (url.origin !== origin || !url.pathname.startsWith(prefix)) return null;
    const rest = url.pathname.slice(prefix.length);
    if (rest === "") return null;
    const segments: string[] = [];
    for (const raw of rest.split("/")) {
      let seg: string;
      try {
        seg = decodeURIComponent(raw);
      } catch {
        return null;
      }
      if (seg === "" || seg === "." || seg === ".." || seg.includes("/")) return null;
      segments.push(seg);
    }
    return segments.join("/");
  };
}

/** Builds the Response for a completed HTTP4 transfer. */
export function responseFor(r: Http4Response, head: boolean): Response {
  return new Response(head ? null : r.body, { status: 200, headers: headersFor(r) });
}

/** Response headers for an HTTP4 transfer: its META plus Content-Length. */
export function headersFor(r: Http4Response): [string, string][] {
  const headers: [string, string][] = Object.entries(r.headers);
  headers.push(["content-length", String(r.body.length)]);
  return headers;
}

/**
 * What HTTP4 made of one request, without falling back: either a response
 * (its body is the transfer's own buffer, so it can be transferred between
 * threads) or the reason the platform fetch should serve it instead.
 */
export type Http4Outcome =
  | { transport: "http4"; status: number; headers: [string, string][]; body: Uint8Array<ArrayBuffer> | null }
  | { transport: "fallback" | "platform"; reason: string };

export class Http4Fetcher {
  private readonly session: AssetRequester | null;
  private readonly unavailable: string | undefined;
  private readonly opts: FetcherOptions;
  private readonly log: RequestReport[] = [];

  /** `session` null means HTTP4 is unavailable for the reason given. */
  constructor(session: AssetRequester | null, unavailableReason: string | undefined, opts: FetcherOptions) {
    this.session = session;
    this.unavailable = unavailableReason;
    this.opts = opts;
  }

  /** Whether requests can currently go over HTTP4. */
  get available(): boolean {
    return this.session?.isOpen ?? false;
  }

  /** Why HTTP4 is not available, if it isn't. */
  get unavailableReason(): string | undefined {
    if (!this.session) return this.unavailable ?? "no HTTP4 session";
    return this.session.isOpen ? undefined : "HTTP4 session closed";
  }

  /** Recent requests, oldest first. */
  report(): RequestReport[] {
    return this.log.slice();
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const t0 = performance.now();
    const req = input instanceof Request ? input : undefined;
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const url = new URL(req ? req.url : String(input), this.opts.baseUrl);
    const signal = init?.signal ?? req?.signal ?? undefined;
    const record = (transport: Transport, status: number, bytes: number | null, reason?: string) => {
      const r: RequestReport = { url: url.href, method, transport, status, ms: performance.now() - t0, bytes };
      if (reason !== undefined) r.reason = reason;
      this.log.push(r);
      if (this.log.length > (this.opts.reportLimit ?? 1000)) this.log.shift();
      this.opts.onRequest?.(r);
    };
    const viaPlatform = async (transport: Transport, reason: string): Promise<Response> => {
      let res: Response;
      try {
        res = await this.opts.platformFetch(input, init);
      } catch (e) {
        record(transport, 0, null, `${reason}; platform fetch failed: ${e}`);
        throw e;
      }
      const len = res.headers.get("content-length");
      record(transport, res.status, len === null ? null : Number(len), reason);
      return res;
    };

    const skip = this.ineligible(method, url, init, req);
    if (skip) return viaPlatform("platform", skip);
    const o = await this.outcome(url, method, signal);
    if (o.transport !== "http4") return viaPlatform(o.transport, o.reason);
    record("http4", o.status, o.body?.length ?? 0);
    return new Response(o.body, { status: o.status, headers: o.headers, ...(o.status === 404 ? { statusText: "Not Found" } : {}) });
  }

  /**
   * Try one GET/HEAD over HTTP4 without falling back or recording it: the
   * Service Worker bridge uses this and does its own fallback and reporting.
   * The caller has already checked method, origin, body and Range.
   */
  async outcome(url: URL, method: string, signal?: AbortSignal): Promise<Http4Outcome> {
    const assetId = this.opts.pathToAssetId(url);
    if (assetId === null) return { transport: "platform", reason: "not an HTTP4 asset path" };
    if (!this.session?.isOpen) return { transport: "fallback", reason: this.unavailableReason ?? "HTTP4 unavailable" };

    signal?.throwIfAborted();
    let r: Http4Response;
    try {
      r = await abortable(this.session.request(assetId), signal);
    } catch (e) {
      if (signal?.aborted && e === signal.reason) throw e;
      if (e instanceof Http4Error && e.code === ErrorCode.NOT_FOUND) {
        // The server answered authoritatively: don't ask again over HTTP.
        return { transport: "http4", status: 404, headers: [], body: null };
      }
      return { transport: "fallback", reason: `HTTP4 ${httpStatusFor(e)}: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { transport: "http4", status: 200, headers: headersFor(r), body: method === "HEAD" ? null : r.body };
  }

  /** Why a request can't go over HTTP4 regardless of its path, or null. */
  private ineligible(method: string, url: URL, init: RequestInit | undefined, req: Request | undefined): string | null {
    if (method !== "GET" && method !== "HEAD") return `method ${method}`;
    if (url.origin !== new URL(this.opts.baseUrl).origin) return "cross-origin";
    if (init?.body != null) return "request has a body";
    if (new Headers(init?.headers ?? req?.headers).has("range")) return "range request";
    return null;
  }
}

/** Rejects with the signal's reason when it aborts. The HTTP4 transfer itself runs on. */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
