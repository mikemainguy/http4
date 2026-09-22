// Client acceptance test (vrek iss-jdww825): real headless Chrome fetches
// assets over HTTP4 from the real server, one at a time and all at once. Each
// result must match the source's SHA-256; every grant in the client's trace
// must have gone to the RPC with the least remaining; and the server must
// report zero un-granted bytes.
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { startHarness, type Harness } from "../support/harness.ts";

// Sizes around the 1007-byte payload of a 1024-byte datagram, the 4 KiB
// initial grant, the 16 KiB minimum grant increment, and the 128 KiB budget.
const SIZES: Record<string, number> = {
  "empty.bin": 0,
  "one.bin": 1,
  "payload.bin": 1007,
  "payload-plus-1.bin": 1008,
  "api.json": 4096,
  "style.css": 20_000,
  "script.js": 150_000,
  "hero.jpg": 2_000_000,
};

let assets: string;
let h: Harness;
let page: Page;
const sha256 = new Map<string, string>();

before(async () => {
  assets = mkdtempSync(path.join(tmpdir(), "http4-fetch-assets-"));
  for (const [name, size] of Object.entries(SIZES)) {
    const b = randomBytes(size);
    writeFileSync(path.join(assets, name), b);
    sha256.set(name, createHash("sha256").update(b).digest("hex"));
  }
  h = await startHarness(assets);
  page = await h.browser.newPage();
  await page.goto(h.http + "/");
  await page.waitForFunction(() => window.__http4 !== undefined, undefined, { timeout: 15_000 });
  const err = await page.evaluate(() => (window.__http4 && "error" in window.__http4 ? window.__http4.error : null));
  assert.equal(err, null, `HTTP4 session failed to open: ${err}`);
});

after(async () => {
  await h?.stop();
  rmSync(assets, { recursive: true, force: true });
});

interface Fetched {
  name: string;
  ok: boolean;
  size?: number;
  sha256?: string;
  error?: string;
  ms: number;
}

/** Fetch the named assets concurrently in the page; hash each result there. */
function fetchInPage(names: string[]): Promise<Fetched[]> {
  return page.evaluate(async (names) => {
    const h = window.__http4;
    if (!h || "error" in h) throw new Error("no HTTP4 session");
    const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    return Promise.all(
      names.map(async (name) => {
        const t0 = performance.now();
        try {
          const b = await h.client.fetch(name);
          return { name, ok: true, size: b.length, sha256: hex(await crypto.subtle.digest("SHA-256", b)), ms: performance.now() - t0 };
        } catch (e) {
          return { name, ok: false, error: String(e), ms: performance.now() - t0 };
        }
      }),
    );
  }, names);
}

function assertIntact(results: Fetched[]): void {
  for (const r of results) {
    assert.ok(r.ok, `${r.name}: ${r.error}`);
    assert.equal(r.size, SIZES[r.name], `${r.name} size`);
    assert.equal(r.sha256, sha256.get(r.name), `${r.name} SHA-256`);
  }
}

/** Grant trace from the page, with bigints made serializable. */
async function takeTrace() {
  return page.evaluate(() => {
    const h = window.__http4;
    if (!h || "error" in h) throw new Error("no HTTP4 session");
    const t = h.trace.splice(0).map((g) => ({ rpcId: g.rpcId.toString(16), remaining: g.remaining, others: g.others }));
    return t;
  });
}

test("single fetches return exact bytes", async () => {
  for (const name of Object.keys(SIZES)) assertIntact(await fetchInPage([name]));
});

test("concurrent fetches return exact bytes, granted shortest-remaining first", async () => {
  await takeTrace(); // discard the single-fetch trace
  const results = await fetchInPage(Object.keys(SIZES));
  assertIntact(results);

  const trace = await takeTrace();
  const violations = trace.filter((t) => t.others.some((o) => o < t.remaining));
  const contended = trace.filter((t) => t.others.length > 0).length;
  assert.deepEqual(violations, [], "a grant went to an RPC while one with less remaining could still take it");
  assert.ok(contended > 0, "no grant was made under contention, so SRPT was not exercised");
  const byTime = [...results].sort((a, b) => a.ms - b.ms).map((r) => `${r.name} ${r.ms.toFixed(1)}ms`);
  console.log(`concurrent: ${trace.length} grants (${contended} under contention); completion: ${byTime.join(", ")}`);
});

test("an unknown asset is rejected with NOT_FOUND", async () => {
  const [r] = await fetchInPage(["does-not-exist.bin"]);
  assert.equal(r!.ok, false);
  assert.match(r!.error!, /NOT_FOUND/);
});

test("server sent zero un-granted bytes", async () => {
  const m = await h.metrics();
  const stats = await page.evaluate(() => {
    const h = window.__http4;
    return h && !("error" in h) ? h.stats() : null;
  });
  console.log(`server: ${JSON.stringify(m)}\nclient: ${JSON.stringify(stats)}`);
  assert.equal(m.ungranted_bytes_sent, 0);
});
