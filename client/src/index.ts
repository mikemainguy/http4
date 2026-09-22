// Public entry of the HTTP4 client library (bundled to client/dist/http4.js).
//
//   import { connect } from "./http4.js";
//   const http4 = await connect();              // discovers /config.json
//   const res = await http4.fetch("/assets/app.css");  // a real Response
//
// connect() never fails outright: if WebTransport is missing, the server
// can't be reached, or the session later closes, fetch() transparently uses
// the platform fetch instead, and report() says so.

import { Http4Fetcher, prefixMapper, type RequestReport } from "./fetcher.ts";
import { Http4Client, type ClientOptions } from "./transport.ts";

export { Http4Client, Http4Error, httpStatusFor } from "./transport.ts";
export type { ClientOptions, ClientStats, Http4Response } from "./transport.ts";
export { prefixMapper } from "./fetcher.ts";
export type { RequestReport, Transport } from "./fetcher.ts";

export const DEFAULT_ASSET_PREFIX = "/assets/";
export const DEFAULT_CONFIG_URL = "/config.json";
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/**
 * Options for connect(). Anything from ClientOptions (budget, initialGrant,
 * rtoFloorMs, …) is passed through to the session. ClientOptions' `trace`
 * and `dropOutgoing` are for tests only.
 */
export interface ConnectOptions extends ClientOptions {
  /** WebTransport URL of the HTTP4 server. If omitted, read from `configUrl`. */
  webTransportUrl?: string;
  /**
   * DEVELOPMENT ONLY: SHA-256 of the server's self-signed certificate, as
   * bytes or base64, for serverCertificateHashes. Production servers use a
   * CA-trusted certificate and leave this unset.
   */
  certHash?: Uint8Array<ArrayBuffer> | string;
  /** JSON with `webTransportUrl` and optional `certHash`, used when `webTransportUrl` is not given. Default "/config.json". */
  configUrl?: string;
  /** Same-origin path prefix whose URLs map to HTTP4 asset IDs. Default "/assets/". */
  assetPrefix?: string;
  /** Custom URL → asset ID mapping (null = not HTTP4). Overrides `assetPrefix`. */
  pathToAssetId?: (url: URL) => string | null;
  /** Base for relative URLs and the same-origin check. Default location.href. */
  baseUrl?: string;
  /** Called after every fetch() with how it was served. */
  onRequest?: (r: RequestReport) => void;
  /** How many recent requests report() keeps. Default 1000. */
  reportLimit?: number;
  /** Give up connecting after this long and serve everything via fallback. Default 5000. */
  connectTimeoutMs?: number;
  /** The fetch used for fallback and non-HTTP4 requests. Default globalThis.fetch. */
  fetch?: typeof fetch;
}

/** A connected (or fallback-only) HTTP4 handle. */
export interface Http4 {
  /** Like the platform fetch; same-origin GET/HEAD asset requests go over HTTP4. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Recent requests and how each was served, oldest first. */
  report(): RequestReport[];
  /** Whether requests can currently go over HTTP4. */
  readonly available: boolean;
  /** Why HTTP4 isn't available, when it isn't. */
  readonly unavailableReason: string | undefined;
  /** The underlying session, for stats and advanced use; undefined in fallback-only mode. */
  readonly client: Http4Client | undefined;
  /** Close the HTTP4 session; later requests use the fallback. */
  close(): void;
}

/** Open an HTTP4 session. Resolves even when HTTP4 is unavailable (fallback-only). */
export async function connect(opts: ConnectOptions = {}): Promise<Http4> {
  const {
    webTransportUrl, certHash, configUrl, assetPrefix, pathToAssetId, baseUrl: base, onRequest, reportLimit,
    connectTimeoutMs, fetch: fetchOpt, ...clientOpts
  } = opts;
  const baseUrl = base ?? globalThis.location?.href;
  if (!baseUrl) throw new TypeError("http4.connect: no baseUrl and no location to default it from");
  const platformFetch = fetchOpt ?? globalThis.fetch.bind(globalThis);

  let client: Http4Client | undefined;
  let reason: string | undefined;
  try {
    client = await openSession(
      webTransportUrl, certHash, new URL(configUrl ?? DEFAULT_CONFIG_URL, baseUrl).href,
      platformFetch, clientOpts, connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }

  const fetcher = new Http4Fetcher(client ?? null, reason, {
    baseUrl,
    pathToAssetId: pathToAssetId ?? prefixMapper(baseUrl, assetPrefix ?? DEFAULT_ASSET_PREFIX),
    platformFetch,
    ...(onRequest ? { onRequest } : {}),
    ...(reportLimit !== undefined ? { reportLimit } : {}),
  });
  return {
    fetch: (input, init) => fetcher.fetch(input, init),
    report: () => fetcher.report(),
    get available() {
      return fetcher.available;
    },
    get unavailableReason() {
      return fetcher.unavailableReason;
    },
    client,
    close: () => client?.close(),
  };
}

async function openSession(
  url: string | undefined,
  hash: Uint8Array<ArrayBuffer> | string | undefined,
  configUrl: string,
  platformFetch: typeof fetch,
  clientOpts: ClientOptions,
  timeoutMs: number,
): Promise<Http4Client> {
  if (typeof WebTransport === "undefined") throw new Error("WebTransport not supported");
  if (url === undefined) {
    const res = await platformFetch(configUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`config ${configUrl}: HTTP ${res.status}`);
    const cfg = (await res.json()) as { webTransportUrl?: string; certHash?: string };
    if (!cfg.webTransportUrl) throw new Error(`config ${configUrl}: no webTransportUrl`);
    url = cfg.webTransportUrl;
    hash ??= cfg.certHash;
  }
  const bytes = typeof hash === "string" ? Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)) : hash;
  const pending = Http4Client.connect(url, bytes, clientOpts);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`WebTransport connect timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } catch (e) {
    // If it connects after all, don't leave the session open unused.
    pending.then((c) => c.close(), () => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
