// Response metadata acceptance test (vrek iss-tj4v2z2): the client reports the
// server's Content-Type (plus ETag and Last-Modified) for each asset, and the
// browser accepts bodies typed with it: a module script runs, a stylesheet
// applies, an image decodes. A module with no type is refused, which is why
// META exists (fnd-7ecs69k). With every first META dropped by the server,
// requests still complete with their metadata.
import { deflateSync, crc32 } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness, type ServerMetrics } from "../support/harness.ts";
import { openPage } from "../support/page.ts";

/** A solid-colour RGB PNG, so the browser has something real to decode. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const ASSETS: Record<string, { body: Buffer; type: string }> = {
  "app.js": { body: Buffer.from('window.__metaModule = "ran";\nexport const answer = 42;\n'), type: "text/javascript" },
  "style.css": { body: Buffer.from("body { background-color: rgb(4, 5, 6); }\n"), type: "text/css" },
  "pic.png": { body: png(64, 48), type: "image/png" },
  "data.json": { body: Buffer.from('{"hello":"http4"}'), type: "application/json" },
};

let dir: string;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "http4-meta-assets-"));
  for (const [name, a] of Object.entries(ASSETS)) writeFileSync(path.join(dir, name), a.body);
});
after(() => rmSync(dir, { recursive: true, force: true }));

type Metrics = ServerMetrics & { meta_packets: number; dropped_meta_packets: number };

describe("clean path", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness(dir);
  });
  after(async () => h?.stop());

  test("the client reports the server's metadata, and Chrome accepts bodies typed with it", async () => {
    const page = await h.browser.newPage();
    await openPage(page, h.http);
    const out = await page.evaluate(async (names) => {
      const h = window.__http4;
      if (!h || "error" in h) throw new Error("no HTTP4 session");
      const headers: Record<string, Record<string, string>> = {};
      const bodies: Record<string, Uint8Array<ArrayBuffer>> = {};
      for (const name of names) {
        const r = await h.client.request(name);
        headers[name] = r.headers;
        bodies[name] = r.body;
      }
      const typed = (name: string) => URL.createObjectURL(new Blob([bodies[name]!], { type: headers[name]!["content-type"] }));

      const mod = await import(typed("app.js"));
      const module = { answer: mod.answer, ran: (window as any).__metaModule };
      let untypedModule: string;
      try {
        await import(URL.createObjectURL(new Blob([bodies["app.js"]!])));
        untypedModule = "ran";
      } catch (e) {
        untypedModule = "rejected: " + (e as Error).message;
      }

      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = typed("style.css");
      await new Promise((r) => { link.onload = r; link.onerror = r; document.head.append(link); });
      const css = getComputedStyle(document.body).backgroundColor;

      const img = new Image();
      img.src = typed("pic.png");
      const image = await img.decode().then(() => [img.naturalWidth, img.naturalHeight], (e) => "error " + e);

      const json = JSON.parse(new TextDecoder().decode(bodies["data.json"]));
      return { headers, module, untypedModule, css, image, json, stats: h.stats() };
    }, Object.keys(ASSETS));

    for (const [name, a] of Object.entries(ASSETS)) {
      const hd = out.headers[name]!;
      assert.ok(hd["content-type"]?.startsWith(a.type), `${name}: content-type ${hd["content-type"]}, want ${a.type}`);
      assert.match(hd["etag"] ?? "", /^"[0-9a-f]{16}"$/, `${name}: etag`);
      assert.ok(!Number.isNaN(Date.parse(hd["last-modified"] ?? "")), `${name}: last-modified ${hd["last-modified"]}`);
    }
    assert.deepEqual(out.module, { answer: 42, ran: "ran" });
    assert.match(out.untypedModule, /^rejected/, "a module with no Content-Type should be refused");
    assert.equal(out.css, "rgb(4, 5, 6)");
    assert.deepEqual(out.image, [64, 48]);
    assert.deepEqual(out.json, { hello: "http4" });
    console.log(`headers: ${JSON.stringify(out.headers)}\nuntyped module: ${out.untypedModule}`);

    const m = (await h.metrics()) as Metrics;
    assert.equal(m.ungranted_bytes_sent, 0);
    assert.ok(m.meta_packets >= Object.keys(ASSETS).length);
  });
});

describe("server drops each first META", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness(dir, ["-drop", "meta"]);
  });
  after(async () => h?.stop());

  test("every request still completes with its metadata", async () => {
    const page = await h.browser.newPage();
    await openPage(page, h.http);
    const out = await page.evaluate(async (names) => {
      const h = window.__http4;
      if (!h || "error" in h) throw new Error("no HTTP4 session");
      const results = await Promise.all(names.map((n) => h.client.request(n).then((r) => ({ n, type: r.headers["content-type"], size: r.body.length }))));
      return { results, stats: h.stats() };
    }, Object.keys(ASSETS));

    for (const r of out.results) {
      assert.ok(r.type?.startsWith(ASSETS[r.n]!.type), `${r.n}: content-type ${r.type}`);
      assert.equal(r.size, ASSETS[r.n]!.body.length);
    }
    const m = (await h.metrics()) as Metrics;
    console.log(
      `meta loss: server dropped ${m.dropped_meta_packets} META, sent ${m.meta_packets}; ` +
        `client REQ retransmits ${out.stats.reqRetransmits}, recoveries ${out.stats.recoveries}`,
    );
    assert.equal(m.dropped_meta_packets, Object.keys(ASSETS).length, "each first META should have been dropped");
    assert.ok(out.stats.reqRetransmits >= Object.keys(ASSETS).length, "recovery should have re-sent the REQs");
    assert.equal(m.ungranted_bytes_sent, 0);
  });
});
