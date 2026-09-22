// Spike: can a Service Worker serve a page's subresources over HTTP4?
// Evidence for vrek findings fnd-q99xxg1, fnd-hnymjv8, fnd-7ecs69k (see README).
//
//   node spikes/sw-webtransport/run.ts
//
// Prints one JSON object. Uses Playwright, which attaches DevTools to Service
// Workers and so keeps them alive; idle termination is tested separately by
// idle-probe.sh, which runs Chrome without DevTools.
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { startHarness } from "../../tests/support/harness.ts";

const dir = import.meta.dirname;

// Generated inputs: the bundled worker and a 3 MB incompressible asset.
buildSync({ entryPoints: [path.join(dir, "sw-src.js")], bundle: true, format: "iife", target: "chrome120", outfile: path.join(dir, "www/sw.js"), logLevel: "warning" });
const big = path.join(dir, "assets/big.bin");
if (!existsSync(big)) writeFileSync(big, randomBytes(3_000_000));

const out: Record<string, unknown> = {};
// Later flags win in Go's flag package, so this overrides the harness's -static.
// The assets are deliberately NOT under www/: anything that loads came over HTTP4.
const h = await startHarness(path.join(dir, "assets"), ["-static", path.join(dir, "www")]);
try {
  const page = await h.browser.newPage();
  const consoleMsgs: string[] = [];
  page.on("console", (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));

  // 1. First visit: the <img> in the HTML is requested before the SW exists.
  await page.goto(h.http + "/");
  await page.evaluate(() => (window as any).__registered);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 });
  out.firstVisitImg = await page.evaluate(() => {
    const img = document.getElementById("first") as HTMLImageElement;
    return { complete: img.complete, naturalWidth: img.naturalWidth };
  });

  // 2. Now controlled (clients.claim): real subresource types through the SW.
  out.subresources = await page.evaluate(async () => {
    const res: Record<string, unknown> = {};
    const img = new Image();
    img.src = "/assets/pic.png";
    res.img = await img.decode().then(() => [img.naturalWidth, img.naturalHeight], (e) => "error " + e);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/style.css";
    await new Promise((r) => { link.onload = r; link.onerror = r; document.head.append(link); });
    res.css = getComputedStyle(document.body).backgroundColor;
    try { await import("/assets/app.js"); res.module = (window as any).__appLoaded; } catch (e) { res.module = "error: " + (e as Error).message; }
    try { await import("/assets/noctype.js"); res.noContentTypeModule = (window as any).__noctypeLoaded ?? "imported, not run"; } catch (e) { res.noContentTypeModule = "rejected: " + (e as Error).message; }
    const r = await fetch("/assets/data.json");
    res.fetchJson = { servedBy: r.headers.get("x-served-by"), type: r.headers.get("content-type"), body: await r.json() };
    const t0 = performance.now();
    const b = await (await fetch("/assets/big.bin")).arrayBuffer();
    res.big = { bytes: b.byteLength, ms: Math.round(performance.now() - t0) };
    return res;
  });
  out.swReport1 = await page.evaluate(() => (window as any).swReport());

  // 3. Reload: the same initial-HTML <img> should now go through the SW.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.waitForFunction(() => (document.getElementById("first") as HTMLImageElement).complete);
  out.afterReloadImg = await page.evaluate(() => (document.getElementById("first") as HTMLImageElement).naturalWidth);

  // 4. Chrome kills the worker (as it does when idle): does the next request recover?
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await cdp.send("ServiceWorker.disable");
  await cdp.detach();
  out.afterKill = await page.evaluate(async () => {
    const t0 = performance.now();
    const r = await fetch("/assets/data.json");
    return { status: r.status, servedBy: r.headers.get("x-served-by"), ms: Math.round(performance.now() - t0) };
  });
  out.swReportAfterKill = await page.evaluate(() => (window as any).swReport());
  out.console = consoleMsgs.filter((m) => !m.startsWith("log:"));
  out.serverMetrics = await h.metrics();
} finally {
  await h.stop();
}
console.log(JSON.stringify(out, null, 2));
