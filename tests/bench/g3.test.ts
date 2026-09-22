// Keeps the G3 benchmark (tests/bench/g3.ts, vrek iss-3ecq28b) from rotting:
// a short clean-loopback run of the same machinery. It asserts the harness
// works — samples collected, every h3 request verified as h3, background load
// actually moving, 0 un-granted bytes — and reports the latencies without
// asserting them, because a test that fails on timing would fail on a busy
// machine. The real numbers come from `npm run bench:g3`.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { startHarness, type Harness } from "../support/harness.ts";
import { makeAssets, type AssetSet } from "../support/assets.ts";
import { buildBench, openBench } from "../support/bench.ts";
import type { BackgroundStats, ForegroundStats, Stack } from "../../client/bench/bench.ts";

const ASSETS: Record<string, number> = { "api-1k.json": 1024, "api-4k.json": 4096, "bg.bin": 2 * 2 ** 20 };
const API_IDS = ["api-1k.json", "api-4k.json"];
const SAMPLES = 150;

let assets: AssetSet;
let h: Harness;
let page: Page;

before(async () => {
  buildBench();
  assets = makeAssets(ASSETS);
  h = await startHarness(assets.dir, [], { h3: true });
  page = await h.browser.newPage();
  await openBench(page, h.http);
});

after(async () => {
  await h?.stop();
  assets?.remove();
});

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? NaN;
};

for (const sp of [
  { name: "http4", stack: "http4" as Stack },
  { name: "h3", stack: "h3" as Stack },
  { name: "h3-high", stack: "h3" as Stack, priority: "high" as const },
]) {
  test(`${sp.name}: API requests under background load`, async () => {
    await page.evaluate(([s]) => window.__bench!.startBackground(s!), [{ stack: sp.stack, id: "bg.bin", concurrency: 2 }] as const);
    const r: ForegroundStats = await page.evaluate(
      ([s]) => window.__bench!.foreground(s!),
      [{ stack: sp.stack, ids: API_IDS, count: SAMPLES, rateHz: 50, seed: 7, ...(sp.priority ? { priority: sp.priority } : {}) }] as const,
    );
    const bg: BackgroundStats = await page.evaluate(() => window.__bench!.stopBackground());

    assert.equal(r.failed, 0, `foreground failures: ${r.errors.join(" | ")}`);
    assert.equal(r.ms.length, SAMPLES);
    assert.ok(bg.completed + bg.aborted > 0, "background load never ran");
    assert.equal(bg.failed, 0, `background failures: ${bg.errors.join(" | ")}`);
    if (sp.stack === "h3") {
      // A silent fallback to TCP would invalidate every comparison.
      assert.deepEqual(Object.keys(r.protocols), ["h3"], `protocols: ${JSON.stringify(r.protocols)}`);
      assert.equal(r.protocols.h3, SAMPLES);
    }
    console.log(
      `${sp.name}: p50 ${pct(r.ms, 50).toFixed(1)} ms, p99 ${pct(r.ms, 99).toFixed(1)} ms ` +
        `(${r.ms.length} samples), background ${bg.completed} downloads, ${(bg.bytes / 2 ** 20 / Math.max(bg.seconds, 0.001)).toFixed(1)} MB/s`,
    );
  });
}

test("the server sent no un-granted bytes", async () => {
  assert.equal((await h.metrics()).ungranted_bytes_sent, 0);
});
