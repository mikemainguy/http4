// The page side of the Service Worker integration. It opens this tab's HTTP4
// session, registers the worker, and answers the requests the worker
// forwards (swproto.ts). A site normally gets all of this from one tag,
// <script src="/http4/auto.js"></script> (auto.ts), but install() can be
// called directly for control over the options.

import { open, type ConnectOptions, type Http4, type Opened } from "./index.ts";
import { SW_URL, isSwMessage, serveReply, type HelloReply, type SwRequestReport } from "./swproto.ts";

export interface InstallOptions extends ConnectOptions {
  /** Where the worker script is served. Default "/http4-sw.js". */
  swUrl?: string;
  /** The worker's scope. Default "/". */
  scope?: string;
  /** Set false to only answer an already-registered worker, without registering one. */
  register?: boolean;
}

/** What install() returns: this tab's HTTP4 handle plus the worker's view of requests. */
export interface Http4Page {
  /** This tab's HTTP4 handle, also usable directly (http4.fetch). */
  readonly ready: Promise<Http4>;
  /** The worker registration, or null if Service Workers are unavailable or registering failed. */
  readonly registration: Promise<ServiceWorkerRegistration | null>;
  /** Whether a worker controls this page, i.e. its subresource requests are being forwarded. */
  readonly controlled: boolean;
  /** How the worker served this tab's requests (or every tab's, with all), oldest first. */
  report(opts?: { all?: boolean }): Promise<SwRequestReport[]>;
}

export function install(opts: InstallOptions = {}): Http4Page {
  const { swUrl = SW_URL, scope = "/", register = true, ...connectOpts } = opts;
  const opened = open(connectOpts);
  const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;

  if (container) {
    container.addEventListener("message", (e) => answer(e, opened, new URL(swUrl, location.href).href));
    // Deliver messages the worker sent before this script ran (they queue until now).
    container.startMessages();
  }
  const registration = container && register
    ? container.register(swUrl, { scope }).catch(() => null)
    : Promise.resolve(container ? container.getRegistration(scope).then((r) => r ?? null) : null);

  return {
    ready: opened.then((o) => o.handle),
    registration,
    get controlled() {
      return container?.controller != null;
    },
    report: (r) => askReport(container, r?.all ?? false),
  };
}

/** Answer one message from our worker. Messages from anything else are ignored. */
function answer(e: MessageEvent, opened: Promise<Opened>, swHref: string): void {
  const src = e.source;
  if (!(src instanceof ServiceWorker) || src.scriptURL !== swHref) return;
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
        .then((o) => o.fetcher.outcome(new URL(m.url), m.method))
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
