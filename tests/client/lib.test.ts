// The library's fetch layer with a fake HTTP4 session and a fake platform
// fetch: which requests go over HTTP4, the Responses it builds, and when and
// why it falls back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Http4Fetcher, prefixMapper, responseFor, type AssetRequester, type RequestReport } from "../../client/src/fetcher.ts";
import { connect } from "../../client/src/index.ts";
import { Http4Error, type Http4Response } from "../../client/src/transport.ts";
import { ErrorCode } from "../../client/src/wire.ts";

const BASE = "http://127.0.0.1:8080/page.html";
const map = prefixMapper(BASE, "/assets/");

test("prefixMapper maps same-origin paths under the prefix to decoded asset IDs", () => {
  const id = (u: string) => map(new URL(u, BASE));
  assert.equal(id("/assets/app.js"), "app.js");
  assert.equal(id("/assets/img/a%20b.png?v=3#x"), "img/a b.png", "percent-decoded, query and fragment ignored");
  assert.equal(id("http://localhost:8080/assets/app.js"), null, "different origin");
  assert.equal(id("http://127.0.0.1:9999/assets/app.js"), null, "different port");
  assert.equal(id("/static/app.js"), null, "outside the prefix");
  assert.equal(id("/assets/"), null, "the prefix itself");
  assert.equal(id("/assets/a//b"), null, "empty segment");
  // The URL parser itself resolves dot segments, encoded or not, exactly as it
  // does for a plain HTTP request, so the mapper sees /assets/b.
  assert.equal(id("/assets/a/%2E%2E/b"), "b", "dot segments resolved by URL parsing");
  assert.equal(id("/assets/../secret"), null, "resolved out of the prefix");
  assert.equal(id("/assets/a%2Fb"), null, "encoded slash");
  assert.equal(id("/assets/%E0%A4%A"), null, "malformed escape");
});

/** A fake session serving `assets`; anything else is NOT_FOUND. */
function fakeSession(assets: Record<string, Http4Response>, opts: { open?: boolean; fail?: Error } = {}) {
  const requested: string[] = [];
  const session: AssetRequester = {
    get isOpen() {
      return opts.open ?? true;
    },
    async request(id) {
      requested.push(id);
      if (opts.fail) throw opts.fail;
      const r = assets[id];
      if (!r) throw new Http4Error(`${id}: NOT_FOUND`, ErrorCode.NOT_FOUND);
      return r;
    },
  };
  return { session, requested };
}

function fakePlatform() {
  const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];
  const platformFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response("from-platform", { status: 200, headers: { "content-length": "13", "content-type": "text/plain" } });
  }) as typeof fetch;
  return { calls, platformFetch };
}

const APP: Http4Response = {
  body: new TextEncoder().encode("export const x = 1;\n") as Uint8Array<ArrayBuffer>,
  headers: { "content-type": "text/javascript; charset=utf-8", etag: '"abc"', "last-modified": "Tue, 22 Sep 2026 12:00:00 GMT" },
};

function fetcher(session: AssetRequester | null, reason?: string, extra: Partial<ConstructorParameters<typeof Http4Fetcher>[2]> = {}) {
  const p = fakePlatform();
  const reports: RequestReport[] = [];
  const f = new Http4Fetcher(session, reason, { baseUrl: BASE, pathToAssetId: map, platformFetch: p.platformFetch, onRequest: (r) => reports.push(r), ...extra });
  return { f, reports, ...p };
}

test("an asset request is served over HTTP4 as a real Response with META headers", async () => {
  const s = fakeSession({ "app.js": APP });
  const { f, calls, reports } = fetcher(s.session);
  const res = await f.fetch("/assets/app.js");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(res.headers.get("etag"), '"abc"');
  assert.equal(res.headers.get("last-modified"), "Tue, 22 Sep 2026 12:00:00 GMT");
  assert.equal(res.headers.get("content-length"), String(APP.body.length));
  assert.equal(await res.text(), "export const x = 1;\n");
  assert.deepEqual(s.requested, ["app.js"]);
  assert.equal(calls.length, 0);
  assert.equal(reports[0]!.transport, "http4");
  assert.equal(reports[0]!.bytes, APP.body.length);
  assert.equal(reports[0]!.url, "http://127.0.0.1:8080/assets/app.js");
});

test("HEAD returns the headers with no body", async () => {
  const { f } = fetcher(fakeSession({ "app.js": APP }).session);
  const res = await f.fetch("/assets/app.js", { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), APP.headers["content-type"]);
  assert.equal(res.body, null);
});

test("a Request object is honoured (URL and method)", async () => {
  const s = fakeSession({ "app.js": APP });
  const { f, calls } = fetcher(s.session);
  assert.equal((await f.fetch(new Request("http://127.0.0.1:8080/assets/app.js"))).status, 200);
  await f.fetch(new Request("http://127.0.0.1:8080/assets/app.js", { method: "POST", body: "x" }));
  assert.equal(calls.length, 1, "the POST Request went to the platform fetch");
});

test("NOT_FOUND over HTTP4 is an authoritative 404, not a fallback", async () => {
  const { f, calls, reports } = fetcher(fakeSession({}).session);
  const res = await f.fetch("/assets/missing.png");
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
  assert.equal(reports[0]!.transport, "http4");
  assert.equal(reports[0]!.status, 404);
});

test("any other HTTP4 failure falls back to the platform fetch with the original arguments", async () => {
  const s = fakeSession({}, { fail: new Http4Error("app.js: no progress after 10 recovery attempts") });
  const { f, calls, reports } = fetcher(s.session);
  const init = { headers: { accept: "text/javascript" } };
  const res = await f.fetch("/assets/app.js", init);
  assert.equal(await res.text(), "from-platform");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input, "/assets/app.js");
  assert.equal(calls[0]!.init, init);
  assert.equal(reports[0]!.transport, "fallback");
  assert.match(reports[0]!.reason!, /HTTP4 502: .*no progress/);
  assert.equal(reports[0]!.bytes, 13);
});

test("no session, or a closed one, means fallback with the reason", async () => {
  let r = fetcher(null, "WebTransport not supported");
  await r.f.fetch("/assets/app.js");
  assert.deepEqual([r.reports[0]!.transport, r.reports[0]!.reason], ["fallback", "WebTransport not supported"]);
  assert.equal(r.f.available, false);

  const closed = fakeSession({ "app.js": APP }, { open: false });
  r = fetcher(closed.session);
  await r.f.fetch("/assets/app.js");
  assert.deepEqual([r.reports[0]!.transport, r.reports[0]!.reason], ["fallback", "HTTP4 session closed"]);
  assert.deepEqual(closed.requested, [], "a closed session is not asked");
});

test("requests HTTP4 can't serve go straight to the platform fetch", async () => {
  const s = fakeSession({ "app.js": APP });
  const { f, calls, reports } = fetcher(s.session);
  await f.fetch("/assets/app.js", { method: "POST", body: "x" });
  await f.fetch("http://example.com/assets/app.js");
  await f.fetch("/assets/app.js", { headers: { range: "bytes=0-9" } });
  await f.fetch("/api/data.json");
  assert.equal(calls.length, 4);
  assert.deepEqual(s.requested, []);
  assert.deepEqual(
    reports.map((r) => [r.transport, r.reason]),
    [
      ["platform", "method POST"],
      ["platform", "cross-origin"],
      ["platform", "range request"],
      ["platform", "not an HTTP4 asset path"],
    ],
  );
});

test("abort: an already-aborted signal rejects; aborting mid-transfer rejects with its reason", async () => {
  const { f } = fetcher(fakeSession({ "app.js": APP }).session);
  await assert.rejects(f.fetch("/assets/app.js", { signal: AbortSignal.abort() }), { name: "AbortError" });

  let release!: () => void;
  const slow: AssetRequester = { isOpen: true, request: () => new Promise((r) => (release = () => r(APP))) };
  const ctl = new AbortController();
  const p = fetcher(slow).f.fetch("/assets/app.js", { signal: ctl.signal });
  ctl.abort(new Error("stop"));
  await assert.rejects(p, /stop/);
  release();
});

test("a failing platform fetch rejects like fetch does and is reported with status 0", async () => {
  const reports: RequestReport[] = [];
  const f = new Http4Fetcher(null, "WebTransport not supported", {
    baseUrl: BASE,
    pathToAssetId: map,
    platformFetch: (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch,
    onRequest: (r) => reports.push(r),
  });
  await assert.rejects(f.fetch("/assets/app.js"), TypeError);
  assert.equal(reports[0]!.status, 0);
  assert.match(reports[0]!.reason!, /Failed to fetch/);
});

test("report() keeps the most recent reportLimit requests", async () => {
  const { f } = fetcher(fakeSession({ "app.js": APP }).session, undefined, { reportLimit: 3 });
  for (let i = 0; i < 5; i++) await f.fetch(`/assets/app.js?i=${i}`);
  assert.deepEqual(f.report().map((r) => new URL(r.url).search), ["?i=2", "?i=3", "?i=4"]);
});

test("responseFor copies META headers and sets content-length", async () => {
  const res = responseFor(APP, false);
  assert.equal(res.headers.get("content-type"), APP.headers["content-type"]);
  assert.equal(res.headers.get("content-length"), String(APP.body.length));
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), APP.body);
});

test("connect() without WebTransport resolves to a fallback-only handle", async () => {
  const { calls, platformFetch } = fakePlatform();
  const h = await connect({ baseUrl: BASE, fetch: platformFetch });
  assert.equal(h.available, false);
  assert.equal(h.unavailableReason, "WebTransport not supported");
  assert.equal(h.client, undefined);
  const res = await h.fetch("/assets/app.js");
  assert.equal(await res.text(), "from-platform");
  assert.equal(calls.length, 1, "no config fetch: WebTransport was missing before discovery");
  assert.deepEqual(
    h.report().map((r) => [r.transport, r.reason]),
    [["fallback", "WebTransport not supported"]],
  );
});
