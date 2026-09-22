// Spike for vrek iss-x6ess8x: how can a page give its Service Worker a
// streaming body, and what does each way cost?
//
//   node spikes/sw-stream/run.ts
//
// Compares: transferring a ReadableStream, posting chunks over a
// MessageChannel, and today's single transferred ArrayBuffer (the baseline).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import { startHarness } from "../../tests/support/harness.ts";

const dir = import.meta.dirname;
buildSync({ entryPoints: [path.join(dir, "sw-src.js")], bundle: true, format: "iife", target: "chrome120", outfile: path.join(dir, "www/sw.js"), logLevel: "warning" });

const assets = mkdtempSync(path.join(tmpdir(), "sw-stream-spike-"));
const h = await startHarness(assets, ["-static", path.join(dir, "www")]);
const out: Record<string, unknown> = {};
try {
  const page = await h.browser.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(h.http + "/");
  await page.evaluate(() => (window as any).__ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 });

  // Three runs each, reporting the median, so one slow first run doesn't mislead.
  for (const mode of ["transfer", "chunks", "buffer"]) {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await page.evaluate((m) => (window as any).__measure(m), mode));
    runs.sort((a: any, b: any) => a.totalMs - b.totalMs);
    out[mode] = runs[1];
  }
  out.transferThrew = await page.evaluate(() => (window as any).__spike.transferThrew);
  out.consoleErrors = errors;
} finally {
  await h.stop();
  rmSync(assets, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 2));
