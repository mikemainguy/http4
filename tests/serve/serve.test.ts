// `http4d serve` acceptance test (vrek iss-e1fks2p): the built binary serves
// examples/hello-site from one directory, with the client bundle embedded.
// In headless Chrome the page's own handle.fetch() calls go over HTTP4 with
// the right bytes and Content-Type; with WebTransport removed they go via the
// fallback and still arrive intact. The server sends 0 un-granted bytes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { root, startHarness, type Harness } from "../support/harness.ts";
import type { Http4, RequestReport } from "../../client/src/index.ts";

const site = path.join(root, "examples/hello-site");
const FETCHED = { "/data.json": "application/json", "/images/badge.png": "image/png" } as const;

interface Hello {
  http4: Http4;
  done: boolean;
}

declare global {
  interface Window {
    __hello?: Hello;
  }
}

let h: Harness;

before(async () => {
  h = await startHarness(site, [], { serve: true });
});

after(async () => {
  await h?.stop();
});

const sha256 = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Loads the page and, in it, re-reads the two HTTP4-fetched resources for checking. */
async function loadHello(page: Page) {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(h.http + "/");
  await page.waitForFunction(() => window.__hello?.done === true, undefined, { timeout: 15_000 });
  const result = await page.evaluate(async (paths) => {
    const { http4 } = window.__hello!;
    const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    const fetched: Record<string, { status: number; type: string | null; sha256: string }> = {};
    for (const p of paths) {
      const res = await http4.fetch(p);
      fetched[p] = { status: res.status, type: res.headers.get("content-type"), sha256: hex(await crypto.subtle.digest("SHA-256", await res.arrayBuffer())) };
    }
    const css = getComputedStyle(document.body).backgroundColor;
    const banner = (document.querySelector("img.banner") as HTMLImageElement).naturalWidth;
    const badge = document.getElementById("badge") as HTMLImageElement;
    await badge.decode();
    return {
      available: http4.available,
      unavailableReason: http4.unavailableReason ?? null,
      report: http4.report() as RequestReport[],
      fetched, css, banner, badgeWidth: badge.naturalWidth,
      greeting: document.getElementById("greeting")!.textContent,
    };
  }, Object.keys(FETCHED));
  assert.deepEqual(pageErrors, [], "page errors");
  return result;
}

function assertContent(r: Awaited<ReturnType<typeof loadHello>>, transport: "http4" | "fallback") {
  for (const [p, type] of Object.entries(FETCHED)) {
    const got = r.fetched[p]!;
    assert.equal(got.status, 200, `${p} status`);
    assert.equal(got.type, type, `${p} Content-Type`);
    assert.equal(got.sha256, sha256(readFileSync(path.join(site, p))), `${p} bytes`);
    const reports = r.report.filter((x) => new URL(x.url).pathname === p);
    assert.ok(reports.length >= 2, `${p}: expected the page's request and ours in the report`);
    for (const x of reports) assert.equal(x.transport, transport, `${p} served by ${x.transport} (${x.reason ?? ""})`);
  }
  const data = JSON.parse(readFileSync(path.join(site, "data.json"), "utf8"));
  assert.equal(r.greeting, data.greeting);
  // The page's own plain-HTTP resources: stylesheet applied, banner decoded, badge from a blob.
  assert.equal(r.css, "rgb(247, 245, 240)");
  assert.equal(r.banner, 240);
  assert.equal(r.badgeWidth, 48);
}

test("serve mode: client bundle, config and pages over HTTP", async () => {
  const lib = await fetch(h.http + "/http4/http4.js");
  assert.equal(lib.status, 200, "embedded /http4/http4.js (run `npm run build` first)");
  assert.match(lib.headers.get("content-type") ?? "", /^text\/javascript/);
  const cfg = (await (await fetch(h.http + "/config.json")).json()) as { assetPrefix: string };
  assert.equal(cfg.assetPrefix, "/");
  const index = await fetch(h.http + "/");
  assert.equal(await index.text(), readFileSync(path.join(site, "index.html"), "utf8"));
});

test("the page's handle.fetch requests go over HTTP4", async () => {
  const page = await h.browser.newPage();
  const r = await loadHello(page);
  assert.equal(r.available, true, `HTTP4 unavailable: ${r.unavailableReason}`);
  assertContent(r, "http4");
  console.log(`http4: ${r.report.map((x) => `${new URL(x.url).pathname} ${x.transport} ${x.bytes}B ${x.ms.toFixed(1)}ms`).join(", ")}`);
  await page.close();
});

test("with WebTransport removed they go via the fallback", async () => {
  const page = await h.browser.newPage();
  await page.addInitScript(() => {
    delete (globalThis as { WebTransport?: unknown }).WebTransport;
  });
  const r = await loadHello(page);
  assert.equal(r.available, false);
  assert.match(r.unavailableReason ?? "", /WebTransport not supported/);
  assertContent(r, "fallback");
  await page.close();
});

test("server sent zero un-granted bytes", async () => {
  const m = await h.metrics();
  assert.ok(m.rpcs >= 4, `expected the HTTP4 run's RPCs, got ${m.rpcs}`);
  assert.equal(m.ungranted_bytes_sent, 0);
});
