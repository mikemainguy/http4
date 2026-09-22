// Streaming bodies end to end (vrek iss-x6ess8x): a large fixture is readable
// long before its transfer finishes, its bytes are still exactly right, a
// failed transfer errors the stream rather than truncating it, and a slow
// reader stops the transfer being granted instead of filling memory.
//
// The page imports nothing but the public bundle, as the library test does.
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { root, startHarness, type Harness } from "../support/harness.ts";
import { makeAssets, type AssetSet } from "../support/assets.ts";

const SIZES = { "big.bin": 4 << 20, "huge.bin": 16 << 20, "small.bin": 4096 };

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>http4 stream test</title>
<script type="module">
  import * as http4 from "./http4.js";
  window.__lib = http4;
  window.__streaming = await http4.connect({});
  window.__buffered = await http4.connect({ stream: false });
  window.__ready = true;
</script>
`;

let assets: AssetSet;
let www: string;
let h: Harness;
let page: Page;

before(async () => {
  assets = makeAssets(SIZES);
  www = mkdtempSync(path.join(tmpdir(), "http4-stream-www-"));
  writeFileSync(path.join(www, "index.html"), PAGE);
  copyFileSync(path.join(root, "client/dist/http4.js"), path.join(www, "http4.js"));
  // Later flags win in Go's flag package, so this replaces the harness's -static.
  h = await startHarness(assets.dir, ["-static", www]);
  page = await h.browser.newPage();
  await page.goto(h.http + "/");
  await page.waitForFunction(() => (window as any).__ready === true, undefined, { timeout: 15_000 });
});

after(async () => {
  await h?.stop();
  assets?.remove();
  if (www) rmSync(www, { recursive: true, force: true });
});

/** Read an asset through the streaming handle, timing the first chunk and the last. */
function readStreamed(name: string, slowMs = 0) {
  return page.evaluate(
    async ({ name, slowMs }) => {
      const handle = (window as any).__streaming;
      const stats = () => handle.client.stats;
      const t0 = performance.now();
      const res: Response = await handle.fetch(`/assets/${name}`);
      const headersMs = performance.now() - t0;
      const reader = res.body!.getReader();
      const parts: Uint8Array[] = [];
      let firstMs = -1;
      let peakDataIn = 0;
      const before = stats().dataBytesIn;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (firstMs < 0) firstMs = performance.now() - t0;
        parts.push(value);
        peakDataIn = Math.max(peakDataIn, stats().dataBytesIn - before);
        if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
      }
      const total = parts.reduce((n, c) => n + c.length, 0);
      const body = new Uint8Array(total);
      let at = 0;
      for (const c of parts) {
        body.set(c, at);
        at += c.length;
      }
      const digest = await crypto.subtle.digest("SHA-256", body);
      return {
        headersMs: +headersMs.toFixed(1),
        firstMs: +firstMs.toFixed(1),
        totalMs: +(performance.now() - t0).toFixed(1),
        bytes: total,
        contentLength: Number(res.headers.get("content-length")),
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
        chunks: parts.length,
        streamPauses: stats().streamPauses,
        peakDataIn,
      };
    },
    { name, slowMs },
  );
}

test("a large body is readable long before the transfer finishes, and its bytes are exact", async () => {
  const r = await readStreamed("big.bin");
  assert.equal(r.bytes, SIZES["big.bin"]);
  assert.equal(r.contentLength, SIZES["big.bin"], "the full length is known before the body arrives");
  assert.equal(r.sha256, assets.sha256.get("big.bin"));
  assert.ok(r.chunks > 1, `a 4 MiB body arrived in ${r.chunks} chunk(s), so nothing streamed`);
  assert.ok(r.firstMs < r.totalMs / 2, `first chunk at ${r.firstMs} ms of ${r.totalMs} ms`);
  console.log(`streamed 4 MiB: headers ${r.headersMs} ms, first chunk ${r.firstMs} ms, complete ${r.totalMs} ms, ${r.chunks} chunks`);
});

test("streaming costs nothing on a small body, which still arrives whole", async () => {
  const r = await readStreamed("small.bin");
  assert.equal(r.bytes, SIZES["small.bin"]);
  assert.equal(r.sha256, assets.sha256.get("small.bin"));
  const buffered = await page.evaluate(async () => {
    const t0 = performance.now();
    const res: Response = await (window as any).__buffered.fetch("/assets/small.bin");
    const b = await res.arrayBuffer();
    return { ms: +(performance.now() - t0).toFixed(1), bytes: b.byteLength };
  });
  assert.equal(buffered.bytes, SIZES["small.bin"]);
  console.log(`4 KiB: streamed ${r.totalMs} ms (${r.chunks} chunk(s)), buffered ${buffered.ms} ms`);
});

test("a slow reader stops the transfer being granted, so memory stays bounded", async () => {
  // A 16 MiB asset with a small budget and queue: were there no backpressure,
  // the whole file would pile up in memory while the reader dawdles.
  const HWM = 128 * 1024;
  const BUDGET = 512 * 1024;
  const r = await page.evaluate(
    async ({ HWM, BUDGET }) => {
      const handle = await (window as any).__lib.connect({ streamHighWaterMark: HWM, budget: BUDGET });
      const stats = () => handle.client.stats;
      const res: Response = await handle.fetch("/assets/huge.bin");
      const reader = res.body!.getReader();
      const start = stats().dataBytesIn;
      let consumed = 0, chunks = 0, held = 0;
      const digest = await crypto.subtle.digest("SHA-256", await (async () => {
        const parts: Uint8Array[] = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parts.push(value);
          consumed += value.length;
          chunks++;
          // Bytes the session has taken in but the reader hasn't consumed.
          held = Math.max(held, stats().dataBytesIn - start - consumed);
          await new Promise((r) => setTimeout(r, 5));
        }
        const all = new Uint8Array(consumed);
        let at = 0;
        for (const p of parts) { all.set(p, at); at += p.length; }
        return all;
      })());
      const out = {
        bytes: consumed, chunks, held, pauses: stats().streamPauses,
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      };
      handle.close();
      return out;
    },
    { HWM, BUDGET },
  );
  assert.equal(r.bytes, SIZES["huge.bin"]);
  assert.equal(r.sha256, assets.sha256.get("huge.bin"), "a throttled read still gets every byte");
  assert.ok(r.pauses > 0, "the reader fell behind and the transfer was paused");
  // Whatever is in flight when the pause takes effect is bounded by the queue
  // plus one budget's worth of already-granted bytes.
  assert.ok(r.held < HWM + BUDGET + 64 * 1024, `held ${r.held} B, expected under ${HWM + BUDGET} B + slack`);
  assert.ok(r.held < SIZES["huge.bin"] / 4, "nothing like the whole body was buffered");
  console.log(`slow reader: ${r.chunks} chunks, ${r.pauses} pauses, peak held ${(r.held / 1024).toFixed(0)} KiB of a 16 MiB body`);
});

test("a session that dies mid-body errors the stream: a truncated body never ends cleanly", async () => {
  const r = await page.evaluate(async () => {
    // A session of its own, so closing it can't disturb the other tests.
    const handle = await (window as any).__lib.connect({});
    const res: Response = await handle.fetch("/assets/big.bin");
    const reader = res.body!.getReader();
    const first = await reader.read();
    handle.close(); // every transfer of that session fails: "session closed"
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) return { firstChunk: first.value?.length ?? 0, ended: "cleanly" };
      }
    } catch (e) {
      return { firstChunk: first.value?.length ?? 0, ended: String(e) };
    }
  });
  assert.ok(r.firstChunk > 0, "the reader had started receiving the body");
  // Either our own "session closed" or the WebTransport error underneath it:
  // what matters is that the reader is told, rather than seeing a clean end.
  assert.match(r.ended, /closed/i, `the stream must error, not end; got: ${r.ended}`);
});

test("the server sent no un-granted bytes throughout", async () => {
  const m = await h.metrics();
  assert.equal(m.ungranted_bytes_sent, 0);
});
