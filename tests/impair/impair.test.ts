// HTTP4 through the UDP impairment proxy (vrek iss-x4fs0fm): headless Chrome
// reaches the server only via the proxy, so every QUIC packet (handshake,
// ACKs, REQ/GRANT/RESEND, DATA) crosses a path with real added delay and
// loss in both directions. Every asset must still arrive intact, the server
// must send zero un-granted bytes, and the client's RTT estimate must see
// the added delay.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { startHarness, type Harness, type ImpairStats } from "../support/harness.ts";
import { makeAssets, PAGE_ASSETS, type AssetSet } from "../support/assets.ts";
import { assertIntact, fetchInPage, openPage } from "../support/page.ts";

let assets: AssetSet;
before(() => {
  assets = makeAssets(PAGE_ASSETS);
});
after(() => assets?.remove());

const RTT_MS = 50;
const SCENARIOS = [
  { name: `${RTT_MS} ms RTT, no loss`, impair: ["-rtt", `${RTT_MS}ms`, "-seed", "1"] },
  { name: `${RTT_MS} ms RTT, 1% loss each way`, impair: ["-rtt", `${RTT_MS}ms`, "-loss", "0.01", "-seed", "1"] },
];

for (const sc of SCENARIOS) {
  describe(sc.name, () => {
    let h: Harness;
    let page: Page;
    let proxyStats: ImpairStats | undefined;

    before(async () => {
      h = await startHarness(assets.dir, [], { impair: sc.impair });
      page = await h.browser.newPage();
      await openPage(page, h.http);
    });
    after(async () => {
      proxyStats = await h?.stop();
      console.log(`${sc.name}: proxy ${JSON.stringify(proxyStats)}`);
    });

    test("every asset arrives intact through the proxy, one at a time and all at once", async () => {
      const names = Object.keys(assets.sizes);
      const single: string[] = [];
      for (const name of names) {
        const { results } = await fetchInPage(page, [name]);
        assertIntact(assets, results);
        single.push(`${name} ${results[0]!.ms.toFixed(0)}`);
      }
      const all = await fetchInPage(page, names);
      assertIntact(assets, all.results);

      const m = await h.metrics();
      const s = all.stats;
      const concurrent = [...all.results].sort((a, b) => a.ms - b.ms).map((r) => `${r.name} ${r.ms.toFixed(0)}`);
      console.log(
        `${sc.name}:\n  single (ms): ${single.join(", ")}\n  concurrent (ms): ${concurrent.join(", ")}\n` +
          `  client: srtt ${s.srttMs?.toFixed(1)} ms, rto ${s.rtoMs.toFixed(0)} ms, recoveries ${s.recoveries}, RESENDs ${s.resendsSent}, ` +
          `REQ retransmits ${s.reqRetransmits}, duplicate bytes ${s.duplicateBytesIn}\n` +
          `  server: resent ${m.resent_bytes} B, un-granted ${m.ungranted_bytes_sent} B`,
      );

      assert.equal(m.ungranted_bytes_sent, 0, "server sent un-granted bytes");
      assert.ok(s.srttMs !== null && s.srttMs >= RTT_MS - 2 && s.srttMs < RTT_MS * 4, `srtt ${s.srttMs} ms does not reflect the ${RTT_MS} ms path`);
    });
  });
}
