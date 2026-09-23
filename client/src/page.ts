// The page side of the Service Worker integration. It opens this tab's HTTP4
// session, registers the worker, and answers the requests the worker
// forwards (swproto.ts). A site normally gets all of this from one tag,
// <script src="/http4/auto.js"></script> (auto.ts), but install() can be
// called directly for control over the options.

import { open, openDisabled, type ConnectOptions, type Http4, type Opened } from "./index.ts";
import { SW_URL, isSwMessage, serveReply, type HelloReply, type SwRequestReport } from "./swproto.ts";

export interface InstallOptions extends ConnectOptions {
  /** Where the worker script is served. Default "/http4-sw.js". */
  swUrl?: string;
  /** The worker's scope. Default "/". */
  scope?: string;
  /** Set false to only answer an already-registered worker, without registering one. */
  register?: boolean;
  /**
   * Turn HTTP4 off for this page: no session is opened and no worker is
   * registered, and an already-registered worker is told at once to use the
   * network, so it doesn't wait for a session that will never come.
   */
  disabled?: boolean;
}

/** A worker report entry as this tab received it, stamped with when (performance.now()). */
export interface PageRequestReport extends SwRequestReport {
  at: number;
}

/** What install() returns: this tab's HTTP4 handle plus the worker's view of requests. */
export interface Http4Page {
  /** This tab's HTTP4 handle, also usable directly (http4.fetch). */
  readonly ready: Promise<Http4>;
  /** The worker registration, or null if Service Workers are unavailable or registering failed. */
  readonly registration: Promise<ServiceWorkerRegistration | null>;
  /** Whether a worker controls this page, i.e. its subresource requests are being forwarded. */
  readonly controlled: boolean;
  /** Whether HTTP4 was turned off for this page (InstallOptions.disabled). */
  readonly disabled: boolean;
  /**
   * How the worker served this tab's requests, oldest first. The tab keeps
   * its own copy, which survives Chrome stopping the idle worker. With all,
   * asks the worker for every tab's requests (only what it still remembers).
   */
  report(opts?: { all?: boolean }): Promise<PageRequestReport[] | SwRequestReport[]>;
  /** Call `listener` for each new report entry of this tab. Returns an unsubscribe function. */
  onReport(listener: (r: PageRequestReport) => void): () => void;
}

const MIRROR_LIMIT = 2000;
export const DISABLED_REASON = "HTTP4 disabled for this page";

export function install(opts: InstallOptions = {}): Http4Page {
  const { swUrl = SW_URL, scope = "/", register = true, disabled = false, ...connectOpts } = opts;
  const opened = disabled
    ? Promise.resolve(openDisabled(DISABLED_REASON, connectOpts))
    : open(connectOpts);
  const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
  const mirror: PageRequestReport[] = [];
  const listeners = new Set<(r: PageRequestReport) => void>();

  if (container) {
    const swHref = new URL(swUrl, location.href).href;
    container.addEventListener("message", (e) => {
      if (!fromOurWorker(e, swHref)) return;
      const m: unknown = e.data;
      if (isSwMessage(m) && m.http4 === "log") {
        const r: PageRequestReport = { ...m.entry, at: performance.now() };
        mirror.push(r);
        if (mirror.length > MIRROR_LIMIT) mirror.shift();
        for (const l of listeners) l(r);
        return;
      }
      answer(e, opened);
    });
    // Deliver messages the worker sent before this script ran (they queue until now).
    container.startMessages();
  }
  const registration = container && register && !disabled
    ? container.register(swUrl, { scope }).catch(() => null)
    : Promise.resolve(container ? container.getRegistration(scope).then((r) => r ?? null) : null);

  return {
    ready: opened.then((o) => o.handle),
    registration,
    get controlled() {
      return container?.controller != null;
    },
    disabled,
    report: (r) => (r?.all ? askReport(container, true) : Promise.resolve(mirror.slice())),
    onReport(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function fromOurWorker(e: MessageEvent, swHref: string): boolean {
  const src = e.source;
  return src instanceof ServiceWorker && src.scriptURL === swHref;
}

/** Answer one request-carrying message from our worker. */
function answer(e: MessageEvent, opened: Promise<Opened>): void {
  const m: unknown = e.data;
  const port = e.ports[0];
  if (!isSwMessage(m) || !port) return;

  switch (m.http4) {
    case "hello": {
      const readyMsg = (o: Opened): HelloReply => {
        const reason = o.handle.unavailableReason;
        return {
          state: "ready",
          available: o.handle.available,
          ...(reason !== undefined ? { reason } : {}),
          assetPrefix: o.assetPrefix ?? null,
        };
      };
      port.postMessage({ state: "connecting" } satisfies HelloReply);
      void opened.then((o) => {
        port.postMessage(readyMsg(o));
        port.close();
      });
      return;
    }
    case "serve":
      void opened
        .then((o) => o.fetcher.outcome(new URL(m.url), m.method, undefined, m.destination))
        .then(
          (o) => {
            const { reply, transfer } = serveReply(o);
            port.postMessage(reply, transfer);
          },
          (err) => port.postMessage({ transport: "fallback", reason: `page bridge: ${err}` }),
        )
        .finally(() => port.close());
      return;
  }
}

function askReport(container: ServiceWorkerContainer | undefined, all: boolean): Promise<SwRequestReport[]> {
  const worker = container?.controller;
  if (!worker) return Promise.resolve([]);
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e: MessageEvent<SwRequestReport[]>) => {
      ch.port1.close();
      resolve(e.data);
    };
    worker.postMessage({ http4: "report", all }, [ch.port2]);
  });
}
