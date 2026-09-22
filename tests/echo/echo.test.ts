// Scaffold acceptance test: a real headless Chrome opens a WebTransport session
// to the Go server (trusting it only via serverCertificateHashes) and gets one
// datagram echoed back. The test owns the server's whole lifecycle — nothing
// is left running afterwards.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";

const root = path.resolve(import.meta.dirname, "../..");

interface Ready {
  event: "ready";
  http: string;
  webtransport: string;
}

let tmp: string;
let server: ChildProcess;
let ready: Ready;
let browser: Browser;

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "http4-echo-"));
  const bin = path.join(tmp, "http4d");
  execFileSync("go", ["build", "-o", bin, "./cmd/http4d"], { cwd: path.join(root, "server"), stdio: "inherit" });

  server = spawn(bin, ["-http", "127.0.0.1:0", "-wt", "127.0.0.1:0", "-static", path.join(root, "client")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [line] = (await Promise.race([
    once(createInterface({ input: server.stdout! }), "line"),
    once(server, "exit").then(([code]) => Promise.reject(new Error(`server exited early with ${code}`))),
  ])) as [string];
  ready = JSON.parse(line);

  // Use an installed Chrome rather than a Playwright-downloaded build.
  browser = await chromium.launch({ channel: process.env.HTTP4_CHROME_CHANNEL ?? "chrome", headless: true });
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("browser echoes a datagram over WebTransport", async () => {
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await page.goto(ready.http + "/");
  await page.waitForFunction(() => window.__echo !== undefined, undefined, { timeout: 15_000 });
  const result = (await page.evaluate(() => window.__echo)) as
    | { ok: true; attempts: number; rttMs: number; maxDatagramSize: number }
    | { ok: false; error: string };

  assert.equal(result.ok, true, `echo failed: ${JSON.stringify(result)}; console: ${consoleErrors.join(" | ")}`);
  if (!result.ok) return;
  assert.ok(result.maxDatagramSize > 0, "maxDatagramSize should be reported");
  console.log(`echo: ${JSON.stringify(result)}`);
});

declare global {
  interface Window {
    __echo?: unknown;
  }
}
