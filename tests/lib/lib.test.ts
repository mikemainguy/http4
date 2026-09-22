// Library acceptance test (vrek iss-61wbbxy): a minimal page that can import
// nothing but the public bundle, client/dist/http4.js, fetches the asset pool
// with handle.fetch() in headless Chrome. It checks bytes, Content-Type,
// what report() says, the fallback when WebTransport is missing, the 404,
// and that non-asset requests go to the platform fetch.
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { root, startHarness, type Harness } from "../support/harness.ts";
import { makeAssets, PAGE_ASSETS, type AssetSet } from "../support/assets.ts";

// The page loads the bundle as a module and exposes it; tests drive it from there.
const PAGE = `<!doctype html>
<meta charset="utf-8"><title>http4 library test</title>
<script type="module">
  import * as http4 from "./http4.js";
  window.__lib = http4;
</script>
`;

let assets: AssetSet;
let www: string;
let h: Harness;

before(async () => {
  assets = makeAssets(PAGE_ASSETS);
  www = mkdtempSync(path.join(tmpdir(), "http4-lib-www-"));
  writeFileSync(path.join(www, "index.html"), PAGE);
  copyFileSync(path.join(root, "client/dist/http4.js"), path.join(www, "http4.js"));
  // Later flags win in Go's flag package, so this replaces the harness's -static.
  h = await startHarness(assets.dir, ["-static", www]);
});

after(async () => {
  await h?.stop();
  assets?.remove();
  if (www) rmSync(www, { recursive: true, force: true });
});

interface Got {
  name: string;
  status: number;
  type: string | null;
  size: number;
  sha256: string;
}

async function openPage(): Promise<Page> {
  const page = await h.browser.newPage();
  await page.goto(h.http + "/");
  await page.waitForFunction(() => (window as any).__lib !== undefined, undefined, { timeout: 10_000 });
  return page;
}

/** In the page: connect (optionally without WebTransport), fetch every name concurrently, and hash the bodies. */
function fetchAll(page: Page, names: string[], noWebTransport: boolean) {
  return page.evaluate(
    async ({ names, noWebTransport }) => {
      if (noWebTransport) delete (window as any).WebTransport;
      const http4 = (window as any).__lib;
      const handle = await http4.connect();
      const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
      const got = await Promise.all(
        names.map(async (name: string) => {
          const res: Response = await handle.fetch(`/assets/${name}`);
          const buf = await res.arrayBuffer();
          return { name, status: res.status, type: res.headers.get("content-type"), size: buf.byteLength, sha256: hex(await crypto.subtle.digest("SHA-256", buf)) };
        }),
      );
      return { got, report: handle.report(), available: handle.available, unavailableReason: handle.unavailableReason ?? null };
    },
    { names, noWebTransport },
  );
}

/** The Content-Type the server's plain-HTTP asset route gives, for comparison. */
async function httpContentType(name: string): Promise<string | null> {
  const res = await fetch(`${h.http}/assets/${name}`);
  await res.arrayBuffer();
  return res.headers.get("content-type");
}

function assertIntact(got: Got[]) {
  for (const g of got) {
    assert.equal(g.status, 200, g.name);
    assert.equal(g.size, assets.sizes[g.name], `${g.name} size`);
    assert.equal(g.sha256, assets.sha256.get(g.name), `${g.name} SHA-256`);
  }
}

test("the public bundle fetches every asset over HTTP4 with correct bytes and Content-Type", async () => {
  const page = await openPage();
  const names = Object.keys(assets.sizes);
  const before = (await h.metrics()).rpcs;
  const r = await fetchAll(page, names, false);
  assert.equal(r.available, true, `HTTP4 unavailable: ${r.unavailableReason}`);
  assertIntact(r.got);
  for (const g of r.got) assert.equal(g.type, await httpContentType(g.name), `${g.name} Content-Type matches the HTTP route`);
  assert.deepEqual(new Set(r.report.map((x: any) => x.transport)), new Set(["http4"]));
  assert.equal(r.report.length, names.length);
  assert.equal((await h.metrics()).rpcs - before, names.length, "one HTTP4 RPC per asset");
  console.log(`http4: ${r.got.map((g) => `${g.name} ${g.type}`).join(", ")}`);
  await page.close();
});

test("without WebTransport everything still loads, via fallback, and report() says why", async () => {
  const page = await openPage();
  const names = Object.keys(assets.sizes);
  const before = (await h.metrics()).rpcs;
  const r = await fetchAll(page, names, true);
  assert.equal(r.available, false);
  assert.equal(r.unavailableReason, "WebTransport not supported");
  assertIntact(r.got);
  assert.ok(r.report.every((x: any) => x.transport === "fallback" && x.reason === "WebTransport not supported"), JSON.stringify(r.report[0]));
  assert.equal((await h.metrics()).rpcs, before, "no HTTP4 RPCs in fallback mode");
  await page.close();
});

test("a missing asset is a 404 from HTTP4; POST and cross-origin requests use the platform fetch", async () => {
  const page = await openPage();
  const r = await page.evaluate(async (crossOrigin) => {
    const handle = await (window as any).__lib.connect();
    const missing = await handle.fetch("/assets/does-not-exist.bin");
    const post = await handle.fetch("/config.json", { method: "POST" });
    const cross = await handle.fetch(crossOrigin, { mode: "no-cors" });
    return { missing: missing.status, post: post.status, cross: cross.type, report: handle.report() };
  }, h.http.replace("127.0.0.1", "localhost") + "/assets/one.bin");
  assert.equal(r.missing, 404);
  assert.equal(r.post, 200);
  assert.equal(r.cross, "opaque");
  assert.deepEqual(
    r.report.map((x: any) => [x.transport, x.status, x.reason ?? null]),
    [
      ["http4", 404, null],
      ["platform", 200, "method POST"],
      ["platform", 0, "cross-origin"],
    ],
  );
  await page.close();
});

test("server sent zero un-granted bytes", async () => {
  assert.equal((await h.metrics()).ungranted_bytes_sent, 0);
});
