// Session sequence numbers (wire v2, vrek iss-fbzcsr1) are negotiated, and
// every combination of server and client settings must work. Through the
// impairment proxy with loss, for each of:
//
//   server default  + client default     -> DATA_SEQ, repairs by number
//   server -no-seq  + client default     -> plain DATA (the server ignores HELLO)
//   server default  + sessionSeq: false  -> plain DATA (no HELLO sent)
//   server -no-seq  + sessionSeq: false  -> plain DATA
//
// every asset arrives intact and the server sends zero un-granted bytes.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { startHarness, type Harness } from "../support/harness.ts";
import { makeAssets, PAGE_ASSETS, type AssetSet } from "../support/assets.ts";
import { openPage } from "../support/page.ts";

let assets: AssetSet;
before(() => {
  assets = makeAssets(PAGE_ASSETS);
});
after(() => assets?.remove());

const IMPAIR = ["-rtt", "20ms", "-loss", "0.02", "-seed", "9"];

const COMBOS = [
  { name: "server and client both offer sequence numbers", noSeq: false, sessionSeq: true, expectSeq: true },
  { name: "server started with -no-seq, client offers them", noSeq: true, sessionSeq: true, expectSeq: false },
  { name: "server supports them, client has sessionSeq: false", noSeq: false, sessionSeq: false, expectSeq: false },
  { name: "neither side uses them", noSeq: true, sessionSeq: false, expectSeq: false },
];

interface Outcome {
  results: { name: string; ok: boolean; size?: number; sha256?: string; error?: string }[];
  stats: { hellosSent: number; seqNegotiated: boolean; dataSeqIn: number; seqResendsSent: number; duplicateBytesIn: number };
}

for (const c of COMBOS) {
  describe(c.name, () => {
    let h: Harness;
    let page: Page;
    before(async () => {
      h = await startHarness(assets.dir, c.noSeq ? ["-no-seq"] : [], { impair: IMPAIR });
      page = await h.browser.newPage();
      await openPage(page, h.http);
    });
    after(async () => h?.stop());

    test(c.expectSeq ? "negotiates DATA_SEQ; everything arrives intact" : "stays on plain DATA; everything arrives intact", async () => {
      const names = Object.keys(assets.sizes);
      const out = (await page.evaluate(
        async ({ names, sessionSeq }) => {
          const h = window.__http4;
          if (!h || "error" in h) throw new Error("no HTTP4 session");
          const client = await h.connect({ sessionSeq });
          const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
          const results = await Promise.all(
            names.map(async (name) => {
              try {
                const b = await client.fetch(name);
                return { name, ok: true, size: b.length, sha256: hex(await crypto.subtle.digest("SHA-256", b)) };
              } catch (e) {
                return { name, ok: false, error: String(e) };
              }
            }),
          );
          const stats = { ...client.stats };
          client.close();
          return { results, stats };
        },
        { names, sessionSeq: c.sessionSeq },
      )) as Outcome;
      for (const r of out.results) {
        assert.ok(r.ok, `${r.name}: ${r.error}`);
        assert.equal(r.size, assets.sizes[r.name]);
        assert.equal(r.sha256, assets.sha256.get(r.name), `${r.name} SHA-256`);
      }
      const m = await h.metrics();
      console.log(
        `${c.name}: HELLOs sent ${out.stats.hellosSent}, server saw ${m.hellos_in}; DATA_SEQ in ${out.stats.dataSeqIn} ` +
          `(server sent ${m.data_seq_packets}); RESEND_SEQs ${out.stats.seqResendsSent}; duplicate bytes ${out.stats.duplicateBytesIn}`,
      );
      assert.equal(m.ungranted_bytes_sent, 0, "server sent un-granted bytes");
      assert.equal(out.stats.seqNegotiated, c.expectSeq);
      if (c.expectSeq) {
        assert.ok(m.data_seq_packets > 0 && out.stats.dataSeqIn > 0, "no DATA_SEQ");
      } else {
        assert.equal(m.data_seq_packets, 0, "server sent DATA_SEQ without negotiating it");
        assert.equal(out.stats.dataSeqIn, 0);
        assert.equal(m.seq_resends, 0, "RESEND_SEQ without negotiation");
      }
      if (!c.sessionSeq) assert.equal(out.stats.hellosSent, 0, "sessionSeq: false must send no HELLO");
    });
  });
}
