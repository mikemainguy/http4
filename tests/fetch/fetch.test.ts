// Client acceptance test (vrek iss-jdww825): real headless Chrome fetches
// assets over HTTP4 from the real server, one at a time and all at once. Each
// result must match the source's SHA-256; every grant in the client's trace
// must have gone to the RPC with the least remaining; and the server must
// report zero un-granted bytes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { startHarness, type Harness } from "../support/harness.ts";
import { makeAssets, PAGE_ASSETS, type AssetSet } from "../support/assets.ts";
import { assertIntact, fetchInPage, openPage } from "../support/page.ts";

let assets: AssetSet;
let h: Harness;
let page: Page;

before(async () => {
  assets = makeAssets(PAGE_ASSETS);
  h = await startHarness(assets.dir);
  page = await h.browser.newPage();
  await openPage(page, h.http);
});

after(async () => {
  await h?.stop();
  assets?.remove();
});

/** Grant trace from the page, with bigints made serializable. */
function takeTrace() {
  return page.evaluate(() => {
    const h = window.__http4;
    if (!h || "error" in h) throw new Error("no HTTP4 session");
    return h.trace.splice(0).map((g) => ({ rpcId: g.rpcId.toString(16), remaining: g.remaining, others: g.others }));
  });
}

test("single fetches return exact bytes", async () => {
  for (const name of Object.keys(assets.sizes)) assertIntact(assets, (await fetchInPage(page, [name])).results);
});

test("concurrent fetches return exact bytes, granted shortest-remaining first", async () => {
  await takeTrace(); // discard the single-fetch trace
  const { results } = await fetchInPage(page, Object.keys(assets.sizes));
  assertIntact(assets, results);

  const trace = await takeTrace();
  const violations = trace.filter((t) => t.others.some((o) => o < t.remaining));
  const contended = trace.filter((t) => t.others.length > 0).length;
  assert.deepEqual(violations, [], "a grant went to an RPC while one with less remaining could still take it");
  assert.ok(contended > 0, "no grant was made under contention, so SRPT was not exercised");
  const byTime = [...results].sort((a, b) => a.ms - b.ms).map((r) => `${r.name} ${r.ms.toFixed(1)}ms`);
  console.log(`concurrent: ${trace.length} grants (${contended} under contention); completion: ${byTime.join(", ")}`);
});

test("an unknown asset is rejected with NOT_FOUND", async () => {
  const [r] = (await fetchInPage(page, ["does-not-exist.bin"])).results;
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
