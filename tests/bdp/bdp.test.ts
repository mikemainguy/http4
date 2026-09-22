// Grant-budget sizing (vrek iss-66pc8rp): the same warm-connection transfers
// over HTTP4 and over plain HTTP/3, on clean loopback and through the
// impairment proxy at 50 and 150 ms RTT (no loss). A fixed 128 KiB budget
// capped HTTP4 at budget ÷ RTT; sized from the measured bandwidth-delay
// product, HTTP4 has to keep pace with HTTP/3 on long paths.
//
// Acceptance, asserted unless BDP_REPORT_ONLY=1 (used to measure the old
// client for comparison):
//   - 150 ms: 50 MiB over HTTP4 within 2× its HTTP/3 time
//   - 50 ms: a 4 KiB API reply over HTTP4 in about one round trip
import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildSync } from "esbuild";
import type { Page } from "playwright-core";
import { root, startHarness, type Harness } from "../support/harness.ts";
import { makeAssets, PAGE_ASSETS, type AssetSet } from "../support/assets.ts";
import type { RequestResult, ScheduledRequest, Stack } from "../../client/bench/bench.ts";

const REPORT_ONLY = process.env.BDP_REPORT_ONLY === "1";
const BIG = "50m.bin"; // 50 MiB, from the deterministic fixture pool

let assets: AssetSet;
before(() => {
  buildSync({
    entryPoints: [path.join(root, "client/bench/bench.ts")],
    bundle: true,
    format: "esm",
    target: "chrome120",
    outdir: path.join(root, "client/bench/dist"),
    logLevel: "warning",
  });
  assets = makeAssets(PAGE_ASSETS);
  try {
    execFileSync(path.join(root, "scripts/gen-fixtures"), ["--check"], { stdio: "ignore" });
  } catch {
    execFileSync(path.join(root, "scripts/gen-fixtures"), [], { stdio: "inherit" });
  }
  copyFileSync(path.join(root, "testdata/assets", BIG), path.join(assets.dir, BIG));
  const manifest = JSON.parse(readFileSync(path.join(root, "testdata/assets/manifest.json"), "utf8")) as { assets: { name: string; sha256: string }[] };
  assets.sha256.set(BIG, manifest.assets.find((a) => a.name === BIG)!.sha256);
});
after(() => assets?.remove());

const batch = (stack: Stack): ScheduledRequest[] => Object.keys(PAGE_ASSETS).map((id) => ({ at: 0, id, stack }));
const span = (rs: RequestResult[]) => Math.max(...rs.map((r) => r.end)) - Math.min(...rs.map((r) => r.start));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function run(page: Page, schedule: ScheduledRequest[]): Promise<RequestResult[]> {
  const rs = await page.evaluate((s) => window.__bench!.run(s), schedule);
  for (const r of rs) {
    assert.ok(r.ok, `${r.stack} ${r.id}: ${r.error}`);
    assert.equal(r.sha256, assets.sha256.get(r.id), `${r.stack} ${r.id} SHA-256`);
  }
  return rs;
}

for (const sc of [
  { name: "0 ms", rttMs: 0, impair: undefined },
  { name: "50 ms", rttMs: 50, impair: ["-rtt", "50ms", "-seed", "1"] },
  { name: "150 ms", rttMs: 150, impair: ["-rtt", "150ms", "-seed", "1"] },
]) {
  describe(`${sc.name} RTT, no loss`, () => {
    let h: Harness;
    let page: Page;
    before(async () => {
      h = await startHarness(assets.dir, [], { h3: true, ...(sc.impair ? { impair: sc.impair } : {}) });
      page = await h.browser.newPage();
      await page.goto(h.http + "/bench/index.html");
      await page.waitForFunction(() => window.__bench !== undefined, undefined, { timeout: 15_000 });
      await page.evaluate(() => window.__bench!.ready);
      // Warm both stacks: HTTP/3's congestion window and HTTP4's estimates.
      await run(page, batch("h3"));
      await run(page, batch("http4"));
    });
    after(async () => {
      await h?.stop();
    });

    test("batch, API reply and 50 MiB: HTTP4 vs HTTP/3 on a warm connection", async () => {
      const batchMs: Record<Stack, number[]> = { h3: [], http4: [] };
      const apiMs: Record<Stack, number[]> = { h3: [], http4: [] };
      for (let i = 0; i < 3; i++) {
        for (const stack of ["h3", "http4"] as const) {
          batchMs[stack].push(span(await run(page, batch(stack))));
          apiMs[stack].push((await run(page, [{ at: 0, id: "api.json", stack }]))[0]!.ms);
        }
      }
      const bigMs: Record<Stack, number> = { h3: 0, http4: 0 };
      for (const stack of ["h3", "http4"] as const) {
        const [r] = await run(page, [{ at: 0, id: BIG, stack }]);
        bigMs[stack] = r!.ms;
      }
      const result = {
        rttMs: sc.rttMs,
        batch: { h3: median(batchMs.h3), http4: median(batchMs.http4), ratio: median(batchMs.http4) / median(batchMs.h3) },
        api: { h3: median(apiMs.h3), http4: median(apiMs.http4) },
        big50MiB: { h3: bigMs.h3, http4: bigMs.http4, ratio: bigMs.http4 / bigMs.h3 },
      };
      console.log(`BDP ${JSON.stringify(result)}`);
      const m = await h.metrics();
      assert.equal(m.ungranted_bytes_sent, 0);
      if (REPORT_ONLY) return;
      if (sc.rttMs === 150) {
        assert.ok(result.big50MiB.ratio <= 2, `50 MiB at 150 ms: HTTP4 ${bigMs.http4.toFixed(0)} ms vs h3 ${bigMs.h3.toFixed(0)} ms`);
      }
      if (sc.rttMs === 50) {
        // One round trip plus scheduling slack; two would be ≥ 100 ms.
        assert.ok(result.api.http4 < 1.6 * sc.rttMs, `api.json over HTTP4 took ${result.api.http4.toFixed(0)} ms at 50 ms RTT`);
      }
    });
  });
}
