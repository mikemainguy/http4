// The demo site (examples/demo-site, vrek iss-116jg0n) under `http4d serve -h3`:
//
// - G7: after the first visit, the % of eligible same-origin subresource bytes
//   (report transport http4 or fallback) that came over HTTP4. Target 100.
// - The site contains no protocol code of its own.
// - G4, page-load version: stylesheet completion, first contentful paint and
//   load with the twelve large images present (index.html) vs without
//   (text-only.html), over HTTP4, plain HTTP and HTTP/3. Reported, not asserted
//   (G4's target question que-hzwqhs8 is open).
//
// Measured loads disable the browser cache (CDP Network.setCacheDisabled):
// Chrome's memory cache otherwise serves a reload's images and stylesheet by
// itself, which is neither HTTP4 nor HTTP/3. Connections stay warm.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { root, startHarness, type Harness } from "../support/harness.ts";

const site = path.join(root, "examples/demo-site");
const RUNS = 5;

before(() => {
  execFileSync(process.execPath, [path.join(site, "gen-images.ts")], { stdio: "ignore" });
});

async function cacheOff(ctx: BrowserContext, page: Page): Promise<void> {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
}

async function done(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__demo !== undefined, undefined, { timeout: 15_000 });
  await page.evaluate(() => (window as any).__demo.done);
}

/** A page in a fresh context whose worker is installed and controls it (a second visit). */
async function http4Page(browser: Browser, origin: string, file = "index.html"): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await cacheOff(ctx, page);
  await page.goto(`${origin}/${file}`);
  await done(page);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 });
  await page.reload();
  await done(page);
  return { ctx, page };
}

interface LoadTiming {
  css: number; // stylesheet responseEnd, ms from navigation start
  fcp: number | null;
  load: number;
}

function readTiming(page: Page): Promise<LoadTiming> {
  return page.evaluate(async () => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const css = performance.getEntriesByType("resource").find((e) => new URL(e.name).pathname.endsWith("/style.css")) as PerformanceResourceTiming;
    // The paint entry can land after load on a fast page; wait briefly for it.
    const fcp = await new Promise<number | null>((resolve) => {
      const hit = () => performance.getEntriesByName("first-contentful-paint")[0]?.startTime;
      if (hit() !== undefined) return resolve(hit()!);
      const obs = new PerformanceObserver(() => {
        if (hit() === undefined) return;
        obs.disconnect();
        resolve(hit()!);
      });
      obs.observe({ type: "paint", buffered: true });
      setTimeout(() => {
        obs.disconnect();
        resolve(hit() ?? null);
      }, 1000);
    });
    return { css: css.responseEnd, fcp, load: nav.loadEventEnd };
  });
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

type Mode = "http4" | "network" | "h3";

/** RUNS reloads of `file` in `mode` after a warm-up visit, each timed. */
async function measure(h: Harness, mode: Mode, file: string): Promise<LoadTiming[]> {
  const ctx = await h.browser.newContext();
  const page = await ctx.newPage();
  await cacheOff(ctx, page);
  const url =
    mode === "h3" ? `${new URL(h.webtransport).origin}/h3/${file}`
    : mode === "network" ? `${h.http}/${file}?http4=off`
    : `${h.http}/${file}`;
  await page.goto(url);
  await done(page);
  if (mode === "http4") await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 });
  const out: LoadTiming[] = [];
  for (let i = 0; i < RUNS; i++) {
    await page.reload();
    await done(page);
    const m = await page.evaluate(() => (window as any).__demo.mode);
    assert.equal(m, mode, `${file} in ${mode} mode reported ${m}`);
    out.push(await readTiming(page));
  }
  await ctx.close();
  return out;
}

async function g4(h: Harness, modes: Mode[], label: string) {
  const rows: Record<string, unknown>[] = [];
  for (const mode of modes) {
    const withImg = await measure(h, mode, "index.html");
    const without = await measure(h, mode, "text-only.html");
    const css = median(withImg.map((t) => t.css));
    const cssAlone = median(without.map((t) => t.css));
    rows.push({
      mode,
      css_with_images_ms: +css.toFixed(1),
      css_text_only_ms: +cssAlone.toFixed(1),
      css_slowdown_pct: +((100 * (css - cssAlone)) / cssAlone).toFixed(1),
      fcp_with_images_ms: +median(withImg.map((t) => t.fcp ?? NaN)).toFixed(1),
      fcp_text_only_ms: +median(without.map((t) => t.fcp ?? NaN)).toFixed(1),
      load_with_images_ms: +median(withImg.map((t) => t.load)).toFixed(1),
    });
  }
  console.log(`G4 page-load (${label}, median of ${RUNS}):\n${rows.map((r) => "  " + JSON.stringify(r)).join("\n")}`);
  return rows;
}

describe("demo site on loopback", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness(site, ["-h3"], { serve: true, h3: true });
  });
  after(async () => h?.stop());

  test("G7: after the first visit, every eligible subresource byte comes over HTTP4", async () => {
    const { ctx, page } = await http4Page(h.browser, h.http);
    // Each entry reaches the tab as a message from the worker; wait for all 18.
    await page
      .waitForFunction(
        async () => ((await window.http4!.report()) as any[]).filter((x) => x.transport === "http4" || x.transport === "fallback").length >= 18,
        undefined,
        { timeout: 5000, polling: 50 },
      )
      .catch(() => {}); // the assertions below say what is missing
    const r = await page.evaluate(async () => {
      const rep = (await window.http4!.report()) as any[];
      const eligible = rep.filter((x) => x.transport === "http4" || x.transport === "fallback");
      const bytes = (xs: any[]) => xs.reduce((n, x) => n + (x.bytes ?? 0), 0);
      const http4 = eligible.filter((x) => x.transport === "http4");
      const byDest: Record<string, number> = {};
      for (const x of http4) byDest[x.destination || "fetch"] = (byDest[x.destination || "fetch"] ?? 0) + 1;
      return {
        g7_pct: eligible.length ? (100 * bytes(http4)) / bytes(eligible) : 0,
        http4_bytes: bytes(http4),
        eligible_bytes: bytes(eligible),
        http4_requests: http4.length,
        eligible_requests: eligible.length,
        by_destination: byDest,
        fallbacks: eligible.filter((x) => x.transport === "fallback").map((x) => `${new URL(x.url).pathname}: ${x.reason}`),
        order: http4.map((x) => new URL(x.url).pathname.split("/").pop()),
        panel: document.querySelector(".panel .head")?.textContent?.replace(/\s+/g, " ").trim(),
        rows: document.querySelectorAll(".panel tbody tr").length,
      };
    });
    console.log(`G7: ${JSON.stringify({ g7_pct: r.g7_pct, http4_bytes: r.http4_bytes, eligible_bytes: r.eligible_bytes, http4_requests: r.http4_requests, by_destination: r.by_destination, fallbacks: r.fallbacks })}`);
    console.log(`completion order over HTTP4: ${r.order.join(", ")}`);
    console.log(`panel: ${r.panel} (${r.rows} rows)`);
    assert.deepEqual(r.fallbacks, []);
    assert.equal(r.g7_pct, 100);
    // 12 images, stylesheet, module, font, 3 JSON calls.
    assert.equal(r.http4_requests, 18, JSON.stringify(r.by_destination));
    assert.deepEqual(r.by_destination, { style: 1, script: 1, image: 12, font: 1, fetch: 3 });
    assert.match(r.panel ?? "", /100% of bytes over HTTP4/);
    await ctx.close();
  });

  test("the site contains no protocol code", () => {
    const files = readdirSync(site, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && /\.(js|html|css)$/.test(d.name))
      .map((d) => path.join(d.parentPath, d.name));
    assert.ok(files.length >= 4);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      assert.doesNotMatch(src, /from\s+["'][^"']*(wire|transport|scheduler|budget|reassembly)[^"']*["']/, `${f} imports protocol code`);
      assert.doesNotMatch(src, /new\s+WebTransport|serverCertificateHashes|datagrams/, `${f} uses WebTransport directly`);
    }
  });

  test("G4 page-load: stylesheet and first paint with and without the images", async () => {
    const rows = await g4(h, ["http4", "network", "h3"], "loopback");
    assert.equal(rows.length, 3);
  });

  test("server sent zero un-granted bytes", async () => {
    assert.equal((await h.metrics()).ungranted_bytes_sent, 0);
  });
});

describe("demo site at 50 ms RTT (HTTP4 and HTTP/3 through the impairment proxy)", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness(site, ["-h3"], { serve: true, h3: true, impair: ["-rtt", "50ms", "-seed", "1"] });
  });
  after(async () => h?.stop());

  // Plain HTTP runs over TCP, which the UDP proxy doesn't touch, so it isn't comparable here.
  test("G4 page-load at 50 ms", async () => {
    const rows = await g4(h, ["http4", "h3"], "50 ms RTT");
    assert.equal(rows.length, 2);
    assert.equal((await h.metrics()).ungranted_bytes_sent, 0);
  });
});
