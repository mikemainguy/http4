// Early RESEND (vrek iss-e58kfkh) through the impairment proxy: loss is
// repaired as soon as later data shows a gap, not after a stall timeout, and
// reordering without loss does not trigger spurious retransmits.
//
// Each scenario fetches the PAGE_ASSETS batch concurrently a few times and
// reports the median batch time, recoveries (timer-driven), early RESENDs and
// duplicate bytes. Every asset must arrive intact and the server must send
// zero un-granted bytes. For context it also times the same batch over plain
// HTTP/3 on the same impaired path (reported, not asserted): at these loss
// rates QUIC's own congestion control, shared by both stacks, sets the pace.
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import type { Page } from "playwright-core";
import { root, startHarness, type Harness } from "../support/harness.ts";
import { makeAssets, PAGE_ASSETS, type AssetSet } from "../support/assets.ts";
import { assertIntact, fetchInPage, openPage } from "../support/page.ts";
import type { RequestResult, ScheduledRequest } from "../../client/bench/bench.ts";

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
});
after(() => assets?.remove());

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

// The page batch without its 2 MB image: through these lossy paths QUIC's
// congestion control holds any single stack to well under 1 MB/s, so the
// full batch would take ~15–20 s a run. ~175 KB still exercises repairs.
const NAMES = Object.keys(PAGE_ASSETS).filter((n) => n !== "hero.jpg");

const RUNS = 3;
const batchBytes = () => NAMES.reduce((n, id) => n + assets.sizes[id]!, 0);

interface Scenario {
  name: string;
  impair: string[];
  // Reordering without loss: repairs would all be spurious.
  noLoss?: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: "50 ms RTT, ±10 ms jitter with reordering, no loss", impair: ["-rtt", "50ms", "-jitter", "10ms", "-reorder", "-seed", "1"], noLoss: true },
  { name: "50 ms RTT, 5% loss each way", impair: ["-rtt", "50ms", "-loss", "0.05", "-seed", "2"] },
  { name: "150 ms RTT, 1% loss each way", impair: ["-rtt", "150ms", "-loss", "0.01", "-seed", "3"] },
];

for (const sc of SCENARIOS) {
  describe(sc.name, () => {
    let h: Harness;
    let page: Page;

    before(async () => {
      h = await startHarness(assets.dir, [], { impair: sc.impair, h3: true });
      page = await h.browser.newPage();
      await openPage(page, h.http);
    });
    after(async () => h?.stop());

    test("for context: the same batch over HTTP/3 vs HTTP4 on this path", async () => {
      const bench = await h.browser.newPage();
      await bench.goto(h.http + "/bench/index.html");
      await bench.waitForFunction(() => window.__bench !== undefined, undefined, { timeout: 15_000 });
      await bench.evaluate(() => window.__bench!.ready);
      const batch = (stack: "h3" | "http4"): ScheduledRequest[] => NAMES.map((id) => ({ at: 0, id, stack }));
      const run = (s: ScheduledRequest[]) => bench.evaluate((x) => window.__bench!.run(x), s) as Promise<RequestResult[]>;
      const span = (rs: RequestResult[]) => Math.max(...rs.map((r) => r.end)) - Math.min(...rs.map((r) => r.start));
      const times: Record<"h3" | "http4", number[]> = { h3: [], http4: [] };
      for (const stack of ["h3", "http4"] as const) await run(batch(stack)); // warm both connections
      for (let i = 0; i < RUNS; i++) {
        for (const stack of ["h3", "http4"] as const) {
          const rs = await run(batch(stack));
          for (const r of rs) assert.ok(r.ok && r.bytes === assets.sizes[r.id], `${stack} ${r.id}: ${r.error}`);
          times[stack].push(span(rs));
        }
      }
      const h3 = median(times.h3);
      const http4 = median(times.http4);
      console.log(`${sc.name}: batch h3 ${h3.toFixed(0)} ms vs HTTP4 ${http4.toFixed(0)} ms (${(http4 / h3).toFixed(2)}×)`);
      await bench.close();
    });

    test("the batch arrives intact; repairs are prompt and not spurious", async () => {
      const names = NAMES;
      await fetchInPage(page, names); // warm up the session, RTT estimate and budget
      const times: number[] = [];
      let dup = 0;
      let recoveries = 0;
      let resends = 0;
      let early = 0;
      for (let i = 0; i < RUNS; i++) {
        // A fresh session per run would reset the budget; the page's own
        // session is warm, like a real page's.
        const before = await page.evaluate(() => {
          const h = window.__http4;
          return h && !("error" in h) ? h.stats() : null;
        });
        const t0 = Date.now();
        const all = await fetchInPage(page, names);
        times.push(Date.now() - t0);
        assertIntact(assets, all.results);
        const s = all.stats as typeof all.stats & { earlyResends?: number };
        const b = before as (typeof s) | null;
        dup += s.duplicateBytesIn - (b?.duplicateBytesIn ?? 0);
        recoveries += s.recoveries - (b?.recoveries ?? 0);
        resends += s.resendsSent - (b?.resendsSent ?? 0);
        early += (s.earlyResends ?? 0) - (b?.earlyResends ?? 0);
      }
      times.sort((a, b) => a - b);
      const m = await h.metrics();
      console.log(
        `${sc.name}: batch median ${times[RUNS >> 1]} ms (runs ${times.join(", ")}); ` +
          `timer recoveries ${recoveries}, RESENDs ${resends} (early ${early}), duplicate bytes ${dup}; ` +
          `server resent ${m.resent_bytes} B`,
      );
      assert.equal(m.ungranted_bytes_sent, 0, "server sent un-granted bytes");
      if (sc.noLoss) {
        // Reordering alone must rarely look like loss. Like RACK, a packet
        // held up longer than the reordering window is repaired once
        // (spuriously) and the window widens, so a few early RESENDs are
        // expected; a storm is not. The stall timer can also re-send a REQ
        // whose META was held up (one duplicate packet 0 each).
        const packets = (RUNS * batchBytes()) / 1183;
        assert.ok(early <= Math.max(5, 0.01 * packets), `${early} early RESENDs with reordering and no loss`);
        assert.ok(dup <= 0.02 * RUNS * batchBytes(), `${dup} duplicate bytes with reordering and no loss`);
      }
    });
  });
}
