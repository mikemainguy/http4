// Shared one-shot test harness: build http4d, run it on free ports with a
// given assets directory, and launch headless Chrome. Everything started here
// is stopped by the returned cleanup; nothing outlives the test process.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser } from "playwright-core";

export const root = path.resolve(import.meta.dirname, "../..");

/** GET /metrics.json, mirroring sender.Snapshot in server/internal/sender/metrics.go. */
export interface ServerMetrics {
  sessions: number;
  rpcs: number;
  packets_in: number;
  malformed_in: number;
  data_packets: number;
  data_bytes: number;
  resent_bytes: number;
  errors_sent: number;
  chunk_shrinks: number;
  rpcs_evicted: number;
  ungranted_bytes_sent: number;
  dropped_data_packets: number;
}

/** Final counters the impairment proxy prints on exit (server/cmd/impair). */
export interface ImpairStats {
  up: { in: number; forwarded: number; dropped_loss: number; dropped_queue: number };
  down: { in: number; forwarded: number; dropped_loss: number; dropped_queue: number };
}

export interface Harness {
  http: string; // page origin, e.g. http://127.0.0.1:53211
  webtransport: string; // as advertised: the proxy's address when impaired
  browser: Browser;
  metrics(): Promise<ServerMetrics>;
  /** Stops everything; resolves with the proxy's counters if one was running. */
  stop(): Promise<ImpairStats | undefined>;
}

export interface HarnessOptions {
  /**
   * Put the UDP impairment proxy in front of WebTransport with these flags,
   * e.g. ["-rtt", "50ms", "-loss", "0.01", "-seed", "1"]. The page is told to
   * connect to the proxy, so every QUIC packet crosses the impaired path.
   */
  impair?: string[];
  /**
   * Launch Chrome so ordinary fetch() to the server's QUIC port uses HTTP/3
   * (the benchmark baseline): force QUIC for that origin and trust the dev
   * certificate by its SPKI hash. serverCertificateHashes only covers
   * WebTransport, so without these flags fetches to /h3/ fail. With `impair`,
   * the forced origin is the proxy, so h3 crosses the same impaired path.
   */
  h3?: boolean;
  /**
   * Run `http4d serve <dir>` instead of the sandbox server: `assetsDir` is
   * then the site directory (pages and assets both), and the client bundle
   * comes from the one embedded by `npm run build`. `extraArgs` are serve's
   * flags.
   */
  serve?: boolean;
}

/** `extraArgs` go to http4d, e.g. ["-drop", "every=7"]. */
export async function startHarness(assetsDir: string, extraArgs: string[] = [], opts: HarnessOptions = {}): Promise<Harness> {
  const tmp = mkdtempSync(path.join(tmpdir(), "http4-test-"));
  const bin = path.join(tmp, "http4d");
  execFileSync("go", ["build", "-o", bin, "./cmd/http4d"], { cwd: path.join(root, "server"), stdio: "inherit" });

  // The proxy's address must be advertised before the proxy can start (it
  // needs the server's listener as its target), so reserve a port for it.
  const proxyAddr = opts.impair ? `127.0.0.1:${await freeUdpPort()}` : undefined;
  const args = opts.serve
    ? ["serve", "-http", "127.0.0.1:0", "-wt", "127.0.0.1:0", ...extraArgs]
    : ["-http", "127.0.0.1:0", "-wt", "127.0.0.1:0", "-static", path.join(root, "client"), "-assets", assetsDir, ...extraArgs];
  if (proxyAddr) args.push("-advertise-wt", proxyAddr);
  if (opts.serve) args.push(assetsDir); // serve's flags must come before the site

  const server = spawn(bin, args, { stdio: ["ignore", "pipe", "inherit"] });
  let proxy: ChildProcess | undefined;
  let proxyLines: ReturnType<typeof createInterface> | undefined;
  const stopServer = async () => {
    let stats: ImpairStats | undefined;
    if (proxy && proxy.exitCode === null && proxy.signalCode === null) {
      const statsLine = once(proxyLines!, "line").catch(() => undefined);
      proxy.kill("SIGTERM");
      await once(proxy, "exit");
      // The stats line may still be buffered when "exit" fires; give it a moment.
      const line = (await Promise.race([statsLine, new Promise((r) => setTimeout(() => r(undefined), 1000))])) as [string] | undefined;
      if (line) stats = JSON.parse(line[0]) as ImpairStats;
    }
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
    rmSync(tmp, { recursive: true, force: true });
    return stats;
  };

  let ready: { http: string; webtransport: string; wt_listen: string; spki: string };
  let browser: Browser;
  try {
    ready = JSON.parse(await firstLine(server, "server"));
    if (proxyAddr) {
      const impairBin = path.join(tmp, "impair");
      execFileSync("go", ["build", "-o", impairBin, "./cmd/impair"], { cwd: path.join(root, "server"), stdio: "inherit" });
      proxy = spawn(impairBin, ["-listen", proxyAddr, "-target", ready.wt_listen, ...opts.impair!], { stdio: ["ignore", "pipe", "inherit"] });
      proxyLines = createInterface({ input: proxy.stdout! });
      await firstLine(proxy, "impairment proxy", proxyLines);
    }
    // Use an installed Chrome rather than a Playwright-downloaded build.
    const chromeArgs = opts.h3
      ? [`--origin-to-force-quic-on=${new URL(ready.webtransport).host}`, `--ignore-certificate-errors-spki-list=${ready.spki}`]
      : [];
    browser = await chromium.launch({ channel: process.env.HTTP4_CHROME_CHANNEL ?? "chrome", headless: true, args: chromeArgs });
  } catch (e) {
    await stopServer();
    throw e;
  }

  return {
    http: ready.http,
    webtransport: ready.webtransport,
    browser,
    async metrics() {
      const res = await fetch(ready.http + "/metrics.json");
      return (await res.json()) as ServerMetrics;
    },
    async stop() {
      await browser.close();
      return stopServer();
    },
  };
}

/** The first stdout line of a child that announces itself with a JSON ready line. */
async function firstLine(child: ChildProcess, name: string, lines = createInterface({ input: child.stdout! })): Promise<string> {
  const [line] = (await Promise.race([
    once(lines, "line"),
    once(child, "exit").then(([code]) => Promise.reject(new Error(`${name} exited early with ${code}`))),
  ])) as [string];
  return line;
}

async function freeUdpPort(): Promise<number> {
  const s = createSocket("udp4");
  await new Promise<void>((r) => s.bind(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise<void>((r) => s.close(r));
  return port;
}
