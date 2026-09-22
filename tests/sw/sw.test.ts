// Service Worker integration acceptance test (vrek iss-s05bzsh, dec-sf6t0g6).
// A plain site whose only HTTP4 setup is <script src="/http4/auto.js"> plus
// /http4-sw.js at its root. Checks, in headless Chrome:
//   0. Step 1: what forwarding through the worker to the page's session adds
//      per request, against the page's own http4.fetch(), small and large.
//   1. The first visit loads everything over the network (not yet controlled).
//   2. After that, every same-origin subresource of the markup (img,
//      stylesheet, module script, font) and a fetch() is served over HTTP4.
//   3. Two tabs at once, each served by its own session.
//   4. With WebTransport unavailable, the page still loads, via fallback.
//
// The site directory is both -static and -assets, so /assets/<name> over
// HTTP and asset ID <name> over HTTP4 are the same file.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext, Page } from "playwright-core";
import { root, startHarness, type Harness } from "../support/harness.ts";
import type { SwRequestReport } from "../../client/src/swproto.ts";

const PAGE = `<!doctype html>
<html><head>
<meta charset="utf-8"><title>http4 sw test</title>
<script src="/http4/auto.js"></script>
<link rel="stylesheet" href="/assets/style.css">
</head><body>
<p class="f">text in the web font</p>
<img id="pic" src="/assets/pic.png">
<script type="module" src="/assets/app.js"></script>
</body></html>
`;
// The module fetches JSON the way app code would; the result lands on window.
const APP_JS = `window.__data = await (await fetch("/assets/data.json")).json();\nwindow.__appRan = true;\n`;
const STYLE_CSS = `@font-face { font-family: T; src: url(/assets/font.woff2); }
body { background-color: rgb(7, 8, 9); }
.f { font-family: T, sans-serif; }
`;

/** A solid-colour RGB PNG of the given size. */
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = png(2, 2);

let site: string;
let h: Harness;
let ctx: BrowserContext;

before(async () => {
  site = mkdtempSync(path.join(tmpdir(), "http4-sw-site-"));
  writeFileSync(path.join(site, "index.html"), PAGE);
  writeFileSync(path.join(site, "style.css"), STYLE_CSS);
  writeFileSync(path.join(site, "app.js"), APP_JS);
  writeFileSync(path.join(site, "data.json"), JSON.stringify({ hello: "http4" }));
  writeFileSync(path.join(site, "pic.png"), PNG);
  writeFileSync(path.join(site, "font.woff2"), randomBytes(2000)); // only its request matters here
  writeFileSync(path.join(site, "small.bin"), randomBytes(4096));
  writeFileSync(path.join(site, "tiny.bin"), randomBytes(1));
  writeFileSync(path.join(site, "big.bin"), randomBytes(2_000_000));
  // The contract: worker at the site root, everything else client-side under /http4/.
  copyFileSync(path.join(root, "client/dist/http4-sw.js"), path.join(site, "http4-sw.js"));
  mkdirSync(path.join(site, "http4"));
  copyFileSync(path.join(root, "client/dist/auto.js"), path.join(site, "http4/auto.js"));
  // Later flags win in Go's flag package, so this replaces the harness's -static.
  h = await startHarness(site, ["-static", site]);
  ctx = await h.browser.newContext();
});

after(async () => {
  await ctx?.close();
  await h?.stop();
  if (site) rmSync(site, { recursive: true, force: true });
});

/** Wait until the page's subresources have done their thing. */
async function loaded(page: Page) {
  await page.waitForFunction(() => (window as any).__appRan === true && (document.getElementById("pic") as HTMLImageElement).complete, undefined, { timeout: 10_000 });
  return page.evaluate(async () => {
    const font = await document.fonts.load("16px T").then(() => "loaded", () => "failed");
    return {
      img: (document.getElementById("pic") as HTMLImageElement).naturalWidth,
      bg: getComputedStyle(document.body).backgroundColor,
      data: (window as any).__data,
      font,
      controlled: navigator.serviceWorker.controller !== null,
    };
  });
}

function report(page: Page, all = false): Promise<SwRequestReport[]> {
  return page.evaluate((all) => window.http4!.report({ all }), all);
}

/** A visited, controlled page: the first visit plus a reload. */
let tabA: Page;

test("first visit loads over the network before the worker controls the page", async () => {
  tabA = await ctx.newPage();
  await tabA.goto(h.http + "/");
  const got = await loaded(tabA);
  assert.equal(got.img, 2, "image decoded");
  assert.equal(got.bg, "rgb(7, 8, 9)", "stylesheet applied");
  assert.deepEqual(got.data, { hello: "http4" }, "module script ran and fetched JSON");
  await tabA.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 });
});

test("after the first visit, every same-origin subresource is served over HTTP4", async () => {
  await tabA.reload();
  const got = await loaded(tabA);
  assert.equal(got.controlled, true);
  assert.equal(got.img, 2);
  assert.equal(got.bg, "rgb(7, 8, 9)");
  assert.deepEqual(got.data, { hello: "http4" });

  const byPath = new Map((await report(tabA)).map((r) => [new URL(r.url).pathname, r]));
  const want: [string, string][] = [
    ["/assets/style.css", "style"],
    ["/assets/pic.png", "image"],
    ["/assets/app.js", "script"],
    ["/assets/font.woff2", "font"],
    ["/assets/data.json", ""],
  ];
  for (const [p, dest] of want) {
    const r = byPath.get(p);
    assert.ok(r, `${p} not seen by the worker`);
    assert.equal(r.transport, "http4", `${p}: ${r.transport} (${r.reason})`);
    assert.equal(r.destination, dest, `${p} destination`);
    assert.equal(r.status, 200);
  }
  // The bootstrap script itself must never be forwarded.
  assert.equal(byPath.get("/http4/auto.js")?.transport, "platform");
});

test("step 1: forwarding overhead of worker → page vs the page's own http4.fetch", async () => {
  const stats = await tabA.evaluate(async () => {
    const http4 = await window.http4!.ready;
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]!;
    const time = async (f: () => Promise<Response>) => {
      const t0 = performance.now();
      const res = await f();
      await res.arrayBuffer();
      return performance.now() - t0;
    };
    const out: Record<string, { direct: number; viaSW: number; n: number }> = {};
    for (const [name, n] of [["tiny.bin", 40], ["small.bin", 40], ["big.bin", 8]] as const) {
      const direct: number[] = [];
      const viaSW: number[] = [];
      for (let i = 0; i < n; i++) {
        // Alternate so drift affects both equally. A query keeps each URL unique for the HTTP cache.
        direct.push(await time(() => http4.fetch(`/assets/${name}?d=${i}`)));
        viaSW.push(await time(() => fetch(`/assets/${name}?s=${i}`, { cache: "no-store" })));
      }
      out[name] = { direct: median(direct), viaSW: median(viaSW), n };
    }
    return out;
  });
  const rep = (await report(tabA)).filter((r) => /\/(tiny|small|big)\.bin/.test(r.url));
  assert.ok(rep.length > 0 && rep.every((r) => r.transport === "http4"), "the measured requests went through the worker over HTTP4");
  for (const [name, s] of Object.entries(stats)) {
    console.log(`step1 ${name}: direct ${s.direct.toFixed(2)} ms, via worker ${s.viaSW.toFixed(2)} ms, overhead ${(s.viaSW - s.direct).toFixed(2)} ms (median of ${s.n})`);
  }
});

test("two tabs at once are each served by their own session", async () => {
  const before = await h.metrics();
  const tabB = await ctx.newPage();
  await tabB.goto(h.http + "/");
  const gotB = await loaded(tabB);
  assert.equal(gotB.controlled, true);
  assert.equal(gotB.bg, "rgb(7, 8, 9)");
  const after = await h.metrics();
  assert.equal(after.sessions - before.sessions, 1, "tab B opened its own HTTP4 session");

  // Both tabs pull the big file at the same time through the one worker.
  const [a, b] = await Promise.all([tabA, tabB].map((p) => p.evaluate(async () => (await (await fetch("/assets/big.bin?both", { cache: "no-store" })).arrayBuffer()).byteLength)));
  assert.equal(a, 2_000_000);
  assert.equal(b, 2_000_000);

  const all = await report(tabA, true);
  const bigs = all.filter((r) => r.url.endsWith("/assets/big.bin?both"));
  assert.equal(bigs.length, 2);
  assert.ok(bigs.every((r) => r.transport === "http4"));
  assert.notEqual(bigs[0]!.clientId, bigs[1]!.clientId, "each request came from, and was served by, its own tab");
  const bOnly = await report(tabB);
  assert.ok(bOnly.length > 0 && bOnly.every((r) => r.clientId === bOnly[0]!.clientId), "report() scopes to the asking tab");
  await tabB.close();
});

test("with WebTransport unavailable the page loads via fallback, and the report says so", async () => {
  const tabC = await ctx.newPage();
  await tabC.addInitScript(() => {
    delete (window as any).WebTransport;
  });
  await tabC.goto(h.http + "/");
  const got = await loaded(tabC);
  assert.equal(got.controlled, true);
  assert.equal(got.img, 2);
  assert.equal(got.bg, "rgb(7, 8, 9)");
  assert.deepEqual(got.data, { hello: "http4" });
  const rep = (await report(tabC)).filter((r) => new URL(r.url).pathname.startsWith("/assets/"));
  assert.ok(rep.length >= 5, `saw ${rep.length} asset requests`);
  for (const r of rep) {
    assert.equal(r.transport, "fallback", `${r.url}: ${r.transport}`);
    assert.match(r.reason ?? "", /WebTransport not supported/);
  }
  await tabC.close();
});

test("server sent zero un-granted bytes", async () => {
  assert.equal((await h.metrics()).ungranted_bytes_sent, 0);
});
