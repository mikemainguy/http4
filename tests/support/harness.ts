// Shared one-shot test harness: build http4d, run it on free ports with a
// given assets directory, and launch headless Chrome. Everything started here
// is stopped by the returned cleanup; nothing outlives the test process.
import { spawn, execFileSync } from "node:child_process";
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

export interface Harness {
  http: string; // page origin, e.g. http://127.0.0.1:53211
  webtransport: string;
  browser: Browser;
  metrics(): Promise<ServerMetrics>;
  stop(): Promise<void>;
}

/** `extraArgs` go to http4d, e.g. ["-drop", "every=7"]. */
export async function startHarness(assetsDir: string, extraArgs: string[] = []): Promise<Harness> {
  const tmp = mkdtempSync(path.join(tmpdir(), "http4-test-"));
  const bin = path.join(tmp, "http4d");
  execFileSync("go", ["build", "-o", bin, "./cmd/http4d"], { cwd: path.join(root, "server"), stdio: "inherit" });

  const args = ["-http", "127.0.0.1:0", "-wt", "127.0.0.1:0", "-static", path.join(root, "client"), "-assets", assetsDir, ...extraArgs];
  const server = spawn(bin, args, { stdio: ["ignore", "pipe", "inherit"] });
  const stopServer = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
    rmSync(tmp, { recursive: true, force: true });
  };

  let ready: { http: string; webtransport: string };
  let browser: Browser;
  try {
    const [line] = (await Promise.race([
      once(createInterface({ input: server.stdout! }), "line"),
      once(server, "exit").then(([code]) => Promise.reject(new Error(`server exited early with ${code}`))),
    ])) as [string];
    ready = JSON.parse(line);
    // Use an installed Chrome rather than a Playwright-downloaded build.
    browser = await chromium.launch({ channel: process.env.HTTP4_CHROME_CHANNEL ?? "chrome", headless: true });
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
      await stopServer();
    },
  };
}
