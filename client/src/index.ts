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
export { install } from "./page.ts";
export type { Http4Page, InstallOptions, PageRequestReport } from "./page.ts";
export type { SwRequestReport } from "./swproto.ts";

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
  /**
   * Same-origin path prefix whose URLs map to HTTP4 asset IDs. Default: the
   * config's `assetPrefix` if it has one (http4d serve uses "/"), else "/assets/".
   */
  assetPrefix?: string;
  /** Custom URL → asset ID mapping (null = not HTTP4). Overrides `assetPrefix`. */
  pathToAssetId?: (url: URL) => string | null;
  /** Base for relative URLs and the same-origin check. Default location.href. */
  baseUrl?: string;
  /** Called after every fetch() with how it was served. */
  onRequest?: (r: RequestReport) => void;
  /** How many recent requests report() keeps. Default 1000. */
  reportLimit?: number;
  /**
   * Hand back a streaming body as soon as the metadata arrives, so the
   * browser parses and compiles while the transfer runs (default true). Off:
   * a Response carries the whole body, as before.
   */
  stream?: boolean;
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
  return (await open(opts)).handle;
}

/** What connect() builds, plus the internals the Service Worker bridge needs. */
export interface Opened {
  handle: Http4;
  fetcher: Http4Fetcher;
  /** The prefix in effect, or undefined when a custom pathToAssetId is used. */
  assetPrefix: string | undefined;
}

/** connect(), also returning the fetcher. Internal: the Service Worker bridge uses it. */
export async function open(opts: ConnectOptions = {}): Promise<Opened> {
  const {
    webTransportUrl, certHash, configUrl, assetPrefix, pathToAssetId, baseUrl: base, onRequest, reportLimit, stream,
    connectTimeoutMs, fetch: fetchOpt, ...clientOpts
  } = opts;
  const baseUrl = base ?? globalThis.location?.href;
  if (!baseUrl) throw new TypeError("http4.connect: no baseUrl and no location to default it from");
  const platformFetch = fetchOpt ?? globalThis.fetch.bind(globalThis);

  let client: Http4Client | undefined;
  let reason: string | undefined;
  const cfg: ServerConfig = {};
  try {
    client = await openSession(
      webTransportUrl, certHash, new URL(configUrl ?? DEFAULT_CONFIG_URL, baseUrl).href, baseUrl,
      platformFetch, clientOpts, connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, cfg,
    );
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }

  const prefix = pathToAssetId ? undefined : (assetPrefix ?? cfg.assetPrefix ?? DEFAULT_ASSET_PREFIX);
  return build(client, reason, prefix, { baseUrl, pathToAssetId, platformFetch, onRequest, reportLimit, stream });
}

/**
 * A fallback-only handle that never opens a session, for a page that turned
 * HTTP4 off. Internal: the Service Worker bridge uses it.
 */
export function openDisabled(reason: string, opts: Pick<ConnectOptions, "baseUrl" | "fetch" | "onRequest" | "reportLimit" | "stream"> = {}): Opened {
  const baseUrl = opts.baseUrl ?? globalThis.location?.href;
  if (!baseUrl) throw new TypeError("http4: no baseUrl and no location to default it from");
  return build(undefined, reason, undefined, {
    baseUrl,
    pathToAssetId: () => null,
    platformFetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    onRequest: opts.onRequest,
    reportLimit: opts.reportLimit,
    stream: opts.stream,
  });
}

function build(
  client: Http4Client | undefined,
  reason: string | undefined,
  prefix: string | undefined,
  o: {
    baseUrl: string;
    pathToAssetId: ((url: URL) => string | null) | undefined;
    platformFetch: typeof fetch;
    onRequest: ((r: RequestReport) => void) | undefined;
    reportLimit: number | undefined;
    stream: boolean | undefined;
  },
): Opened {
  const fetcher = new Http4Fetcher(client ?? null, reason, {
    baseUrl: o.baseUrl,
    pathToAssetId: o.pathToAssetId ?? prefixMapper(o.baseUrl, prefix!),
    platformFetch: o.platformFetch,
    ...(o.onRequest ? { onRequest: o.onRequest } : {}),
    ...(o.reportLimit !== undefined ? { reportLimit: o.reportLimit } : {}),
    ...(o.stream !== undefined ? { stream: o.stream } : {}),
  });
  const handle: Http4 = {
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
  return { handle, fetcher, assetPrefix: prefix };
}

/** The parts of /config.json the client reads. */
interface ServerConfig {
  webTransportUrl?: string;
  certHash?: string;
  assetPrefix?: string;
}

/**
 * A page can carry the same JSON inline, so opening a session costs no round
 * trip of its own:
 *
 *   <script type="application/http4-config">{"webTransportUrl":"…"}</script>
 *
 * That matters most on a slow link, where the chain HTML → auto.js →
 * /config.json → handshake finishes after the browser has already dispatched
 * the subresources the session was meant to carry (vrek fnd-sgw2sbh). `http4d
 * serve` injects this into the HTML it serves; /config.json stays the fallback
 * for a hand-written page, so a bare tag keeps working.
 */
export const INLINE_CONFIG_TYPE = "application/http4-config";

/** The page's inline config, or undefined when there isn't a usable one. */
function inlineConfig(): ServerConfig | undefined {
  if (typeof document === "undefined") return undefined;
  const el = document.querySelector(`script[type="${INLINE_CONFIG_TYPE}"]`);
  const text = el?.textContent?.trim();
  if (!text) return undefined;
  try {
    const cfg: unknown = JSON.parse(text);
    // A malformed or empty block is ignored rather than fatal: /config.json
    // still answers, so a bad inline block costs a round trip, not the session.
    return typeof cfg === "object" && cfg !== null ? (cfg as ServerConfig) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Absolute https URL for a config's webTransportUrl. WebTransport parses its
 * argument with no base, so a relative URL throws there; resolving it against
 * the page lets a config say "/wt" and stay correct on whatever host serves
 * it. A non-https result is reported here rather than as WebTransport's own
 * opaque SyntaxError.
 */
export function resolveWTUrl(raw: string, baseUrl: string): string {
  let u: URL;
  try {
    u = new URL(raw, baseUrl);
  } catch {
    throw new Error(`webTransportUrl ${JSON.stringify(raw)} is not a URL`);
  }
  if (u.protocol !== "https:") {
    throw new Error(`webTransportUrl ${u.href} is not https (WebTransport requires it)`);
  }
  return u.href;
}

async function openSession(
  url: string | undefined,
  hash: Uint8Array<ArrayBuffer> | string | undefined,
  configUrl: string,
  baseUrl: string,
  platformFetch: typeof fetch,
  clientOpts: ClientOptions,
  timeoutMs: number,
  cfgOut: ServerConfig,
): Promise<Http4Client> {
  const noWebTransport = typeof WebTransport === "undefined";
  if (url === undefined) {
    // An inline config is already in the parsed HTML, so it saves the round
    // trip /config.json would cost before the session can even be attempted.
    // An unusable one (not a URL, or not https — e.g. a relative URL on a page
    // the dev server serves over plain HTTP) is discarded rather than fatal,
    // so it costs that round trip back and not the session. That is what lets
    // a page ship a relative "/wt" that is right in production and simply
    // ignored against a development server.
    const inline = inlineConfig();
    const inlineUrl = inline?.webTransportUrl;
    let usable: string | undefined;
    if (inlineUrl !== undefined) {
      try {
        usable = resolveWTUrl(inlineUrl, baseUrl);
      } catch {
        usable = undefined;
      }
    }
    if (usable !== undefined) {
      Object.assign(cfgOut, inline, { webTransportUrl: usable });
    } else {
      // Read the config even without WebTransport, because its assetPrefix
      // decides which requests count as HTTP4-eligible fallbacks. Then a
      // config problem is secondary: the reason reported is the missing API.
      try {
        const res = await platformFetch(configUrl, { cache: "no-store" });
        if (!res.ok) throw new Error(`config ${configUrl}: HTTP ${res.status}`);
        Object.assign(cfgOut, (await res.json()) as ServerConfig);
      } catch (e) {
        if (!noWebTransport) throw e;
      }
    }
    if (noWebTransport) throw new Error("WebTransport not supported");
    if (!cfgOut.webTransportUrl) throw new Error(`config ${configUrl}: no webTransportUrl`);
    // WebTransport itself rejects a relative URL (it parses with no base) and
    // anything but https. Resolving here lets a config say "/wt" and stay
    // correct on whatever host serves the page, which is what makes an inline
    // block portable instead of pinned to one deployment.
    url = resolveWTUrl(cfgOut.webTransportUrl, baseUrl);
    // An absent or empty certHash means a normally-trusted certificate: open
    // the session without serverCertificateHashes and let the browser verify.
    hash ??= cfgOut.certHash || undefined;
  }
  if (noWebTransport) throw new Error("WebTransport not supported");
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
