// HTTP/3 baseline acceptance test (vrek iss-0sjtwnx): headless Chrome fetches
// every asset over plain HTTP/3 from the same QUIC port as HTTP4, and each
// fetch must be verified as h3 (Resource Timing nextHopProtocol) with the
// right SHA-256, on clean loopback and through the impairment proxy at
// 50 ms RTT. It also reports, without asserting, how long the same
// concurrent batch takes over h3 and over HTTP4.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { startHarness, type Harness } from "../support/harness.ts";
import { makeAssets, PAGE_ASSETS, type AssetSet } from "../support/assets.ts";
import { buildBench, openBench } from "../support/bench.ts";
import type { RequestResult, ScheduledRequest } from "../../client/bench/bench.ts";

let assets: AssetSet;
before(() => {
  buildBench();
  assets = makeAssets(PAGE_ASSETS);
});
after(() => assets?.remove());

function run(page: Page, schedule: ScheduledRequest[]): Promise<RequestResult[]> {
  return page.evaluate((s) => window.__bench!.run(s), schedule);
}

function assertIntactH3(results: RequestResult[]): void {
  for (const r of results) {
    assert.ok(r.ok, `${r.id}: ${r.error}`);
    assert.equal(r.bytes, assets.sizes[r.id], `${r.id} size`);
    assert.equal(r.sha256, assets.sha256.get(r.id), `${r.id} SHA-256`);
    if (r.stack === "h3") assert.equal(r.protocol, "h3", `${r.id} nextHopProtocol`);
  }
}

const batch = (stack: "h3" | "http4"): ScheduledRequest[] => Object.keys(PAGE_ASSETS).map((id) => ({ at: 0, id, stack }));
const batchMs = (rs: RequestResult[]) => Math.max(...rs.map((r) => r.end)) - Math.min(...rs.map((r) => r.start));

for (const sc of [
  { name: "clean loopback", impair: undefined },
  { name: "through the impairment proxy at 50 ms RTT", impair: ["-rtt", "50ms", "-seed", "1"] },
]) {
  describe(sc.name, () => {
    let h: Harness;
    let page: Page;
    before(async () => {
      h = await startHarness(assets.dir, [], { h3: true, ...(sc.impair ? { impair: sc.impair } : {}) });
      page = await h.browser.newPage();
      await openBench(page, h.http);
    });
    after(async () => {
      const stats = await h?.stop();
      // Proves the h3 traffic crossed the proxy rather than reaching the server directly.
      if (stats) console.log(`${sc.name}: proxy forwarded ${stats.down.forwarded} packets down, ${stats.up.forwarded} up`);
      if (sc.impair) assert.ok(stats && stats.down.forwarded > 1000, "h3 traffic did not go through the proxy");
    });

    test("every asset arrives intact over verified h3, one at a time and all at once", async () => {
      for (const id of Object.keys(PAGE_ASSETS)) assertIntactH3(await run(page, [{ at: 0, id, stack: "h3" }]));
      assertIntactH3(await run(page, batch("h3")));
      assertIntactH3(await run(page, batch("h3").map((r) => ({ ...r, priority: "high" as const }))));
    });

    test("same concurrent batch, h3 vs HTTP4 (reported, not asserted)", async () => {
      // Alternate stacks to spread any warm-up effect; take the median of 5.
      const times: Record<string, number[]> = { h3: [], http4: [] };
      for (let i = 0; i < 5; i++) {
        for (const stack of ["h3", "http4"] as const) {
          const rs = await run(page, batch(stack));
          assertIntactH3(rs);
          times[stack]!.push(batchMs(rs));
        }
      }
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      console.log(
        `${sc.name}: concurrent batch of ${Object.keys(PAGE_ASSETS).length} assets, median of 5: ` +
          `h3 ${med(times.h3!).toFixed(1)} ms [${times.h3!.map((x) => x.toFixed(0)).join(", ")}], ` +
          `HTTP4 ${med(times.http4!).toFixed(1)} ms [${times.http4!.map((x) => x.toFixed(0)).join(", ")}]`,
      );
      const m = await h.metrics();
      assert.equal(m.ungranted_bytes_sent, 0);
    });
  });
}
