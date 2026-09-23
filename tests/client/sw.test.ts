// The pure parts of the Service Worker integration: which requests the worker
// forwards, how replies carry bodies, the "/" asset prefix http4d serve uses,
// and the library honouring config.json's assetPrefix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Http4Fetcher, prefixMapper, type AssetRequester } from "../../client/src/fetcher.ts";
import { open } from "../../client/src/index.ts";
import { leaveToNetwork, serveReply, type InterceptInput } from "../../client/src/swproto.ts";
import { Http4Error } from "../../client/src/transport.ts";
import { ErrorCode } from "../../client/src/wire.ts";

const ORIGIN = "http://127.0.0.1:8080";
const req = (over: Partial<InterceptInput>): InterceptInput => ({
  url: ORIGIN + "/assets/app.js", method: "GET", mode: "cors", hasRange: false, clientId: "tab-1", ...over,
});

test("the worker forwards same-origin GET/HEAD subresources and leaves everything else alone", () => {
  assert.equal(leaveToNetwork(req({}), ORIGIN), null);
  assert.equal(leaveToNetwork(req({ method: "HEAD", mode: "no-cors" }), ORIGIN), null);
  assert.equal(leaveToNetwork(req({ mode: "navigate", clientId: "" }), ORIGIN), "navigation");
  assert.equal(leaveToNetwork(req({ method: "POST" }), ORIGIN), "method POST");
  assert.equal(leaveToNetwork(req({ url: "https://cdn.example/x.js" }), ORIGIN), "cross-origin");
  assert.equal(leaveToNetwork(req({ hasRange: true }), ORIGIN), "range request");
  assert.equal(leaveToNetwork(req({ clientId: "" }), ORIGIN), "no client");
  // Its own files never go to a page that may not have loaded them yet.
  for (const p of ["/http4/auto.js", "/http4/http4.js", "/http4-sw.js", "/config.json"]) {
    assert.equal(leaveToNetwork(req({ url: ORIGIN + p }), ORIGIN), "HTTP4 bootstrap file", p);
  }
});

test("a reply transfers the body's own buffer and copies a view into a larger one", () => {
  const own = new Uint8Array([1, 2, 3]);
  const a = serveReply({ transport: "http4", status: 200, headers: [], body: own });
  assert.equal(a.transfer[0], own.buffer, "whole buffer is transferred, not copied");

  const view = new Uint8Array(new ArrayBuffer(10), 2, 3);
  view.set([7, 8, 9]);
  const b = serveReply({ transport: "http4", status: 200, headers: [], body: view });
  assert.notEqual(b.transfer[0], view.buffer, "a view is copied, so the rest of its buffer isn't sent");
  assert.deepEqual([...new Uint8Array(b.transfer[0] as ArrayBuffer)], [7, 8, 9]);

  const none = serveReply({ transport: "fallback", reason: "x" });
  assert.deepEqual(none, { reply: { transport: "fallback", reason: "x" }, transfer: [] });
});

test("a streaming reply transfers the stream itself, with the length for the report", () => {
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>();
  const { reply, transfer } = serveReply({ transport: "http4", status: 200, headers: [["content-length", "9"]], body: null, stream, length: 9 });
  assert.deepEqual(transfer, [stream], "the stream is what crosses to the worker");
  assert.equal(reply.transport === "http4" && reply.stream, stream);
  assert.equal(reply.transport === "http4" && reply.body, null, "no buffer alongside the stream");
  assert.equal(reply.transport === "http4" && reply.length, 9);
});

test('asset prefix "/" (http4d serve) maps every same-origin path to itself without the leading slash', () => {
  const map = prefixMapper(ORIGIN + "/", "/");
  const id = (p: string) => map(new URL(p, ORIGIN));
  assert.equal(id("/pic.png"), "pic.png");
  assert.equal(id("/img/a%20b.png?v=1"), "img/a b.png");
  assert.equal(id("/"), null, "the root itself is not an asset");
  assert.equal(id("/a//b"), null);
});

test("config.json's assetPrefix is honoured even without WebTransport", async () => {
  const fakeFetch = (cfg: object) => async (input: RequestInfo | URL) => {
    assert.match(String(input), /\/config\.json$/);
    return new Response(JSON.stringify(cfg), { headers: { "content-type": "application/json" } });
  };
  const base = ORIGIN + "/index.html";
  // Node has no WebTransport, so these are fallback-only, which is exactly the
  // case where the prefix still decides "fallback" (eligible) vs "platform".
  const served = await open({ baseUrl: base, fetch: fakeFetch({ webTransportUrl: "https://x/wt", assetPrefix: "/" }) });
  assert.equal(served.assetPrefix, "/");
  assert.match(served.handle.unavailableReason ?? "", /WebTransport not supported/);
  assert.deepEqual(await served.fetcher.outcome(new URL(ORIGIN + "/pic.png"), "GET"), {
    transport: "fallback",
    reason: "WebTransport not supported",
  });

  const legacy = await open({ baseUrl: base, fetch: fakeFetch({ webTransportUrl: "https://x/wt" }) });
  assert.equal(legacy.assetPrefix, "/assets/", "default when the config has none");
  assert.equal((await legacy.fetcher.outcome(new URL(ORIGIN + "/pic.png"), "GET")).transport, "platform");

  const explicit = await open({ baseUrl: base, assetPrefix: "/static/", fetch: fakeFetch({ assetPrefix: "/" }) });
  assert.equal(explicit.assetPrefix, "/static/", "an explicit option wins over the config");
});

test("an inline config is used instead of fetching /config.json, and a bad one falls back to it", async () => {
  const base = ORIGIN + "/index.html";
  let fetched = 0;
  const countingFetch = (cfg: object) => async (input: RequestInfo | URL) => {
    assert.match(String(input), /\/config\.json$/);
    fetched++;
    return new Response(JSON.stringify(cfg), { headers: { "content-type": "application/json" } });
  };
  // Stand in for the page's document: only querySelector on the config block.
  const withInline = (text: string | null, run: () => Promise<void>) => {
    const g = globalThis as { document?: unknown };
    const had = "document" in g;
    const prev = g.document;
    g.document = { querySelector: (sel: string) => (sel.includes("application/http4-config") && text !== null ? { textContent: text } : null) };
    return run().finally(() => {
      if (had) g.document = prev;
      else delete g.document;
    });
  };

  await withInline('{"webTransportUrl":"https://inline/wt","assetPrefix":"/"}', async () => {
    fetched = 0;
    const o = await open({ baseUrl: base, fetch: countingFetch({ webTransportUrl: "https://fetched/wt", assetPrefix: "/assets/" }) });
    assert.equal(fetched, 0, "the inline config saves the round trip");
    assert.equal(o.assetPrefix, "/", "and its assetPrefix is the one in effect");
  });

  // Malformed, empty, and absent-webTransportUrl blocks are ignored rather
  // than fatal: they cost a round trip, not the session.
  for (const bad of ["{not json", "", "   ", "{}", '{"assetPrefix":"/"}', "[1,2]"]) {
    await withInline(bad, async () => {
      fetched = 0;
      const o = await open({ baseUrl: base, fetch: countingFetch({ webTransportUrl: "https://fetched/wt", assetPrefix: "/" }) });
      assert.equal(fetched, 1, `"${bad}" should fall back to /config.json`);
      assert.equal(o.assetPrefix, "/");
    });
  }

  // No document at all (the library used outside a page) still works.
  fetched = 0;
  const o = await open({ baseUrl: base, fetch: countingFetch({ webTransportUrl: "https://fetched/wt", assetPrefix: "/" }) });
  assert.equal(fetched, 1);
  assert.equal(o.assetPrefix, "/");
});

test("outcome() gives HTTP4 bodies, a HEAD without one, an authoritative 404, and fallback reasons", async () => {
  const body = new Uint8Array([104, 105]);
  const session: AssetRequester = {
    isOpen: true,
    async request(id) {
      if (id === "hi.txt") return { body, headers: { "content-type": "text/plain" } };
      if (id === "broken") throw new Http4Error("stalled");
      throw new Http4Error("nope", ErrorCode.NOT_FOUND);
    },
  };
  const f = new Http4Fetcher(session, undefined, {
    baseUrl: ORIGIN + "/",
    pathToAssetId: prefixMapper(ORIGIN + "/", "/assets/"),
    platformFetch: () => Promise.reject(new Error("unused")),
  });
  const u = (p: string) => new URL(ORIGIN + p);

  const get = await f.outcome(u("/assets/hi.txt"), "GET");
  assert.equal(get.transport, "http4");
  if (get.transport !== "http4") return;
  assert.equal(get.body, body);
  assert.deepEqual(get.headers, [["content-type", "text/plain"], ["content-length", "2"]]);

  const head = await f.outcome(u("/assets/hi.txt"), "HEAD");
  assert.equal(head.transport === "http4" && head.body, null);

  assert.deepEqual(await f.outcome(u("/assets/gone"), "GET"), { transport: "http4", status: 404, headers: [], body: null });
  const broken = await f.outcome(u("/assets/broken"), "GET");
  assert.equal(broken.transport, "fallback");
  assert.deepEqual(await f.outcome(u("/other/x"), "GET"), { transport: "platform", reason: "not an HTTP4 asset path" });
});
