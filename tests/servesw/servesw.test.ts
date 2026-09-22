// End-to-end regression for the drop-in stack as a site author uses it:
// `http4d serve <dir>` (assetPrefix "/") plus a plain site whose only HTTP4
// addition is <script src="/http4/auto.js">. Covers what neither the serve
// nor the Service Worker tests do on their own: the two together, the tab's
// report surviving the worker being stopped, and the ?http4=off switch.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { startHarness, type Harness } from "../support/harness.ts";

const site = path.join(import.meta.dirname, "site");
let h: Harness;

before(async () => {
  h = await startHarness(site, [], { serve: true });
});
after(async () => h?.stop());

interface Seen {
  bg: string;
  img: number;
  data: unknown;
  report: { path: string; transport: string; destination: string; reason?: string }[];
}

/** Wait for the page's own resources, then read what it rendered and the tab's report. */
async function seen(page: Page): Promise<Seen> {
  await page.waitForFunction(
    () => (window as any).__data && (document.getElementById("pic") as HTMLImageElement).complete,
    undefined,
    { timeout: 10_000 },
  );
  return page.evaluate(async () => ({
    bg: getComputedStyle(document.body).backgroundColor,
    img: (document.getElementById("pic") as HTMLImageElement).naturalWidth,
    data: (window as any).__data,
    report: ((await window.http4!.report()) as any[]).map((r) => ({
      path: new URL(r.url).pathname,
      transport: r.transport,
      destination: r.destination,
      ...(r.reason ? { reason: r.reason } : {}),
    })),
  }));
}

/**
 * First visit (installs the worker), then a reload that the worker controls.
 * The browser cache is off for the page: Chrome's memory cache otherwise
 * serves a reload's stylesheet and image itself, and they never reach the
 * worker (a cache hit is neither HTTP4 nor fallback).
 */
async function controlledPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.goto(h.http + "/");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 });
  await page.reload();
  return page;
}

const SUBRESOURCES = ["/style.css", "/img/pic.png", "/app.js", "/data.json"];

function assertRendered(s: Seen): void {
  assert.equal(s.bg, "rgb(7, 8, 9)", "stylesheet applied");
  assert.ok(s.img > 0, "image decoded");
  assert.deepEqual(s.data, { ok: true }, "JSON fetched");
}

test("first visit uses the network, then every subresource comes over HTTP4", async () => {
  const ctx = await h.browser.newContext();
  const first = await ctx.newPage();
  await first.goto(h.http + "/");
  const firstSeen = await seen(first);
  assertRendered(firstSeen);
  assert.ok(
    firstSeen.report.every((r) => !SUBRESOURCES.includes(r.path) || r.transport !== "http4"),
    `first visit should not be HTTP4: ${JSON.stringify(firstSeen.report)}`,
  );
  await first.close();

  const page = await controlledPage(ctx);
  const s = await seen(page);
  assertRendered(s);
  for (const p of SUBRESOURCES) {
    const r = s.report.find((x) => x.path === p);
    assert.equal(r?.transport, "http4", `${p}: ${JSON.stringify(r)}`);
  }
  for (const r of s.report.filter((x) => !SUBRESOURCES.includes(x.path))) {
    assert.equal(r.transport, "platform", `bootstrap ${r.path} should be left to the network`);
  }
  await ctx.close();
});

test("the tab's report survives the worker being stopped, and serving resumes", async () => {
  const ctx = await h.browser.newContext();
  const page = await controlledPage(ctx);
  const before = await seen(page);
  assert.ok(before.report.filter((r) => r.transport === "http4").length >= SUBRESOURCES.length);

  // What Chrome does to an idle worker (fnd-f844ews): its in-memory log is gone.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await cdp.send("ServiceWorker.disable");
  await cdp.detach();

  const after = await page.evaluate(async () => {
    const r = await fetch("/data.json?after-stop");
    await r.json();
    await new Promise((res) => setTimeout(res, 100)); // let the log message arrive
    const tab = ((await window.http4!.report()) as any[]).map((x) => `${x.transport} ${new URL(x.url).pathname}${new URL(x.url).search}`);
    const worker = ((await window.http4!.report({ all: true })) as any[]).length;
    return { tab, worker };
  });
  // The tab still has every entry from before the stop, plus the new one...
  assert.ok(after.tab.length >= before.report.length + 1, `tab report lost entries: ${JSON.stringify(after.tab)}`);
  assert.ok(after.tab.includes("http4 /data.json?after-stop"), `after the stop: ${JSON.stringify(after.tab)}`);
  // ...while the restarted worker only remembers what happened since.
  assert.ok(after.worker < after.tab.length, `worker kept ${after.worker} of ${after.tab.length}`);
  await ctx.close();
});

test("?http4=off in a fresh context loads everything over plain HTTP, with no worker", async () => {
  const ctx = await h.browser.newContext();
  const page = await ctx.newPage();
  await page.goto(h.http + "/?http4=off");
  const s = await seen(page);
  assertRendered(s);
  const state = await page.evaluate(async () => ({
    disabled: window.http4!.disabled,
    registered: (await navigator.serviceWorker.getRegistrations()).length,
    controlled: navigator.serviceWorker.controller !== null,
  }));
  assert.deepEqual(state, { disabled: true, registered: 0, controlled: false });
  await ctx.close();
});

test("?http4=off with the worker already installed goes straight to the network", async () => {
  const ctx = await h.browser.newContext();
  const page = await controlledPage(ctx);
  await seen(page);
  const t0 = Date.now();
  await page.goto(h.http + "/?http4=off");
  const s = await seen(page);
  const ms = Date.now() - t0;
  assertRendered(s);
  for (const p of SUBRESOURCES) {
    const r = s.report.find((x) => x.path === p);
    assert.equal(r?.transport, "fallback", `${p}: ${JSON.stringify(r)}`);
    assert.match(r!.reason ?? "", /disabled/);
  }
  // The page answers the worker at once, so nothing waits out the 500 ms hello timeout.
  assert.ok(ms < 1500, `off-mode load took ${ms} ms`);
  console.log(`off-mode load with worker installed: ${ms} ms`);
  await ctx.close();
});

test("server sent zero un-granted bytes", async () => {
  assert.equal((await h.metrics()).ungranted_bytes_sent, 0);
});
