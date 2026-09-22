// Does a streamed body reach the browser as a stream through the Service
// Worker, and does it help a big module script? (vrek iss-x6ess8x)
//
// The worker forwards each request to the tab, which answers with a
// transferred ReadableStream, so the worker's Response streams on to the page
// while the transfer is still arriving. Chrome compiles a script as it
// downloads, which is not directly observable; what is observable is the time
// from asking for the module to it executing, streaming vs buffered.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext, Page } from "playwright-core";
import { startHarness, type Harness } from "../support/harness.ts";

// ~3 MiB of real JavaScript: enough that parsing and compiling it costs
// something, so overlapping that with the download can show up.
function bundle(): string {
  const parts = ['globalThis.__sum = 0;\n'];
  for (let i = 0; i < 40_000; i++) parts.push(`export function f${i}(x) { return x + ${i}; }\nglobalThis.__sum += f${i}(1);\n`);
  parts.push('globalThis.__executedAt = performance.now();\n');
  return parts.join("");
}

const PAGE = `<!doctype html>
<meta charset="utf-8"><link rel="icon" href="data:,">
<title>http4 streaming through the Service Worker</title>
<script type="module">
  import { install } from "/http4/http4.js";
  const streaming = new URLSearchParams(location.search).get("stream") !== "off";
  window.http4 = install({ stream: streaming }); // what auto.js exposes, and what report() is read from
  await window.http4.ready;
  window.__ready = true;
</script>
`;

let site: string;

before(() => {
  site = mkdtempSync(path.join(tmpdir(), "http4-swstream-"));
  writeFileSync(path.join(site, "index.html"), PAGE);
  writeFileSync(path.join(site, "bundle.js"), bundle());
});

after(() => {
  if (site) rmSync(site, { recursive: true, force: true });
});

/** A page the worker controls, with the browser cache off so every load transfers. */
async function controlled(h: Harness, ctx: BrowserContext, streaming: boolean): Promise<Page> {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const url = `${h.http}/?stream=${streaming ? "on" : "off"}`;
  await page.goto(url);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 });
  await page.reload(); // now controlled from the first byte
  await page.waitForFunction(() => (window as any).__ready === true, undefined, { timeout: 10_000 });
  return page;
}

/** Load the page six times, alternating, and return the median of each side. */
async function compare(h: Harness) {
  const ctx = await h.browser.newContext();
  const runs: Record<string, number[]> = { streaming: [], buffered: [] };
  let transport = "";
  let bytes: number | null = null;
  for (const streaming of [true, false, true, false, true, false]) {
    const page = await controlled(h, ctx, streaming);
    const r = await importBundle(page, Math.random());
    runs[streaming ? "streaming" : "buffered"]!.push(r.totalMs);
    transport = r.transport;
    bytes = r.bytes;
    await page.close();
  }
  await ctx.close();
  const median = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  return { streaming: median(runs.streaming!), buffered: median(runs.buffered!), runs, transport, bytes };
}

/** Import the bundle (a fresh URL each time, so it really transfers) and time it. */
async function importBundle(page: Page, n: number) {
  return page.evaluate(async (n) => {
    const t0 = performance.now();
    await import(`/bundle.js?v=${n}`);
    const done = performance.now();
    const report = (await window.http4!.report()) as { url: string; transport: string; bytes: number | null }[];
    const entry = report.filter((r) => r.url.includes("/bundle.js")).pop();
    return {
      totalMs: +(done - t0).toFixed(1),
      executedMs: +(((globalThis as any).__executedAt as number) - t0).toFixed(1),
      transport: entry?.transport ?? "unknown",
      bytes: entry?.bytes ?? null,
    };
  }, n);
}

test("a big module script streams through the worker and executes, on a fast path", async () => {
  const h = await startHarness(site, [], { serve: true });
  try {
    const r = await compare(h);
    assert.equal(r.transport, "http4", "the module came over HTTP4 through the worker");
    assert.ok((r.bytes ?? 0) > 2 << 20, `the bundle is ${r.bytes} bytes`);
    console.log(
      `bundle ${((r.bytes ?? 0) / 2 ** 20).toFixed(1)} MiB through the worker, loopback: ` +
        `streaming ${r.streaming} ms (${r.runs.streaming!.join("/")}), buffered ${r.buffered} ms (${r.runs.buffered!.join("/")})`,
    );
  } finally {
    await h.stop();
  }
});

test("the same module over a path with real delay, where overlapping the download can pay", async () => {
  // 40 ms RTT: the transfer now takes long enough that parsing it as it
  // arrives has something to overlap with.
  const h = await startHarness(site, [], { serve: true, impair: ["-rtt", "40ms", "-seed", "1"] });
  try {
    const r = await compare(h);
    assert.equal(r.transport, "http4");
    console.log(
      `bundle ${((r.bytes ?? 0) / 2 ** 20).toFixed(1)} MiB through the worker, 40 ms RTT: ` +
        `streaming ${r.streaming} ms (${r.runs.streaming!.join("/")}), buffered ${r.buffered} ms (${r.runs.buffered!.join("/")})`,
    );
  } finally {
    await h.stop();
  }
});
