// Loss-recovery acceptance test (vrek iss-dfchynh): with datagrams deliberately
// dropped, by the server (-drop) and/or by the client (dropOutgoing), every
// transfer still completes with the right SHA-256. Recovery must actually have
// happened (drops counted, RESENDs or REQ retransmits sent), and the server
// must still send zero un-granted bytes.
//
// Speed (vrek iss-e58kfkh): each scenario's concurrent batch is timed as the
// median of a few fresh sessions, against a lossless baseline measured the
// same way. With every 7th DATA dropped the batch must finish within 3× the
// baseline, which needs loss repaired as soon as it shows, not after a stall.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { startHarness, type Harness } from "../support/harness.ts";
import { makeAssets, PAGE_ASSETS, type AssetSet } from "../support/assets.ts";
import { assertIntact, fetchInPage, openPage, type ClientDropSpec } from "../support/page.ts";
import type { ClientStats } from "../../client/src/transport.ts";

let assets: AssetSet;
before(() => {
  assets = makeAssets(PAGE_ASSETS);
});
after(() => assets?.remove());

interface Scenario {
  name: string;
  serverDrop?: string; // http4d -drop spec
  clientDrop?: ClientDropSpec;
  baseline?: boolean; // no loss: the reference batch time
  maxVsBaseline?: number; // the median batch must be within this × the baseline
}

const BATCH_RUNS = 3;
let baselineMs: number | undefined;

const SCENARIOS: Scenario[] = [
  { name: "no loss (baseline)", baseline: true },
  { name: "server drops every 7th DATA", serverDrop: "every=7", maxVsBaseline: 3 },
  { name: "server drops each packet 0 and each final chunk once", serverDrop: "packet0,final" },
  { name: "server drops 5% of DATA at random", serverDrop: "rate=0.05,seed=3" },
  { name: "client drops each first REQ and every 3rd GRANT", clientDrop: { firstReq: true, grantEvery: 3 } },
  {
    name: "both sides lossy: 3% DATA, every 4th GRANT, every 2nd RESEND",
    serverDrop: "rate=0.03,seed=11",
    clientDrop: { grantEvery: 4, resendEvery: 2 },
  },
];

for (const sc of SCENARIOS) {
  describe(sc.name, () => {
    let h: Harness;
    let page: Page;

    before(async () => {
      h = await startHarness(assets.dir, sc.serverDrop ? ["-drop", sc.serverDrop] : []);
      page = await h.browser.newPage();
      await openPage(page, h.http);
    });
    after(async () => h?.stop());

    test("every asset arrives intact, one at a time and all at once", async () => {
      const names = Object.keys(assets.sizes);
      // A clean session when only the server is lossy; a lossy one otherwise.
      const drop = sc.clientDrop ?? {};
      const stats: ClientStats[] = [];
      for (const name of names) {
        const r = await fetchInPage(page, [name], drop);
        assertIntact(assets, r.results);
        stats.push(r.stats);
      }
      const batches: number[] = [];
      let all!: Awaited<ReturnType<typeof fetchInPage>>;
      for (let i = 0; i < BATCH_RUNS; i++) {
        all = await fetchInPage(page, names, drop);
        assertIntact(assets, all.results);
        stats.push(all.stats);
        batches.push(Math.max(...all.results.map((r) => r.ms)));
      }
      batches.sort((a, b) => a - b);
      const batch = batches[BATCH_RUNS >> 1]!;

      const m = await h.metrics();
      const sum = (k: "recoveries" | "resendsSent" | "earlyResends" | "reqRetransmits" | "droppedOutgoing" | "duplicateBytesIn") =>
        stats.reduce((n, s) => n + ((s as unknown as Record<string, number>)[k] ?? 0), 0);
      console.log(
        `${sc.name}: server dropped ${m.dropped_data_packets}, resent ${m.resent_bytes} B; ` +
          `client dropped ${sum("droppedOutgoing")}, recoveries ${sum("recoveries")}, RESENDs ${sum("resendsSent")} (early ${sum("earlyResends")}), ` +
          `REQ retransmits ${sum("reqRetransmits")}, duplicate bytes ${sum("duplicateBytesIn")}; ` +
          `concurrent batch median ${batch.toFixed(0)} ms (${batches.map((b) => b.toFixed(0)).join(", ")}), ` +
          `srtt ${all.stats.srttMs?.toFixed(2)} ms, rto ${all.stats.rtoMs.toFixed(0)} ms`,
      );

      assert.equal(m.ungranted_bytes_sent, 0, "server sent un-granted bytes");
      if (sc.baseline) {
        baselineMs = batch;
        assert.equal(sum("duplicateBytesIn"), 0, "duplicate bytes without any loss");
        return;
      }
      assert.ok(m.dropped_data_packets + sum("droppedOutgoing") > 0, "scenario injected no loss");
      assert.ok(sum("recoveries") + sum("earlyResends") > 0, "no recovery was needed, so recovery was not tested");
      if (sc.maxVsBaseline !== undefined) {
        assert.ok(baselineMs !== undefined, "baseline scenario did not run first");
        assert.ok(
          batch <= sc.maxVsBaseline * baselineMs,
          `batch ${batch.toFixed(0)} ms is more than ${sc.maxVsBaseline}× the ${baselineMs.toFixed(0)} ms lossless baseline`,
        );
      }
    });
  });
}
