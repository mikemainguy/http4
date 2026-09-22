// Streaming bodies (vrek iss-x6ess8x), in the parts that need no browser:
// the fetch layer's streaming Response, and the scheduler's pause, which is
// how a slow reader stops its transfer being granted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Http4Fetcher, prefixMapper, type AssetRequester } from "../../client/src/fetcher.ts";
import { SrptScheduler } from "../../client/src/scheduler.ts";
import { Http4Error, type Http4Response, type Http4Stream } from "../../client/src/transport.ts";
import { ErrorCode } from "../../client/src/wire.ts";

const BASE = "http://127.0.0.1:8080/page.html";
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

/** A session whose streaming body is fed chunk by chunk under the test's control. */
function streamingSession(size: number, headers: Record<string, string> = { "content-type": "text/javascript" }) {
  let push!: (b: Uint8Array<ArrayBuffer>) => void;
  let close!: () => void;
  let fail!: (e: Error) => void;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(c) {
      push = (b) => c.enqueue(b);
      close = () => c.close();
      fail = (e) => c.error(e);
    },
  });
  const session: AssetRequester = {
    isOpen: true,
    request: () => Promise.reject(new Error("the streaming path should have been used")),
    requestStream: async (id): Promise<Http4Stream> => {
      if (id === "missing.js") throw new Http4Error("missing.js: NOT_FOUND", ErrorCode.NOT_FOUND);
      return { body, size, headers };
    },
  };
  return { session, push, close, fail };
}

function fetcher(session: AssetRequester, opts: { stream?: boolean } = {}) {
  return new Http4Fetcher(session, undefined, {
    baseUrl: BASE,
    pathToAssetId: prefixMapper(BASE, "/assets/"),
    platformFetch: () => Promise.reject(new Error("platform fetch should not be used")),
    ...(opts.stream === undefined ? {} : { stream: opts.stream }),
  });
}

test("a streaming Response arrives before its body, and its headers carry the full length", async () => {
  const s = streamingSession(3000);
  const res = await fetcher(s.session).fetch("/assets/app.js");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/javascript");
  assert.equal(res.headers.get("content-length"), "3000", "the declared size, though no body byte has arrived");

  const reader = res.body!.getReader();
  s.push(bytes(1000));
  const first = await reader.read();
  assert.equal(first.value?.length, 1000, "readable while the transfer is still running");
  s.push(bytes(2000));
  s.close();
  const second = await reader.read();
  assert.equal(second.value?.length, 2000);
  assert.equal((await reader.read()).done, true);
});

test("a transfer that fails mid-body errors the stream: a truncated body never ends cleanly", async () => {
  const s = streamingSession(3000);
  const res = await fetcher(s.session).fetch("/assets/app.js");
  const reader = res.body!.getReader();
  s.push(bytes(1000));
  assert.equal((await reader.read()).value?.length, 1000);
  s.fail(new Http4Error("app.js: no progress after 10 recovery attempts (1000/3000 bytes)"));
  await assert.rejects(reader.read(), /no progress/, "the reader is told, rather than seeing a clean end");
});

test("report() records a streamed request at its declared length, and NOT_FOUND still short-circuits", async () => {
  const s = streamingSession(3000);
  const f = fetcher(s.session);
  s.push(bytes(3000));
  s.close();
  await (await f.fetch("/assets/app.js")).arrayBuffer();
  const missing = await f.fetch("/assets/missing.js");
  assert.equal(missing.status, 404);

  const [streamed, notFound] = f.report() as [ReturnType<typeof f.report>[0], ReturnType<typeof f.report>[0]];
  assert.equal(streamed!.transport, "http4");
  assert.equal(streamed!.bytes, 3000);
  assert.equal(notFound!.status, 404);
  assert.equal(notFound!.transport, "http4", "an authoritative 404 is not a fallback");
});

test("stream: false keeps the buffered path, as HEAD always does", async () => {
  const body: Http4Response = { body: bytes(500), headers: { "content-type": "text/css" } };
  let streamCalls = 0;
  const session: AssetRequester = {
    isOpen: true,
    request: async () => body,
    requestStream: async () => {
      streamCalls++;
      throw new Error("not reached");
    },
  };
  const buffered = await fetcher(session, { stream: false }).fetch("/assets/a.css");
  assert.equal((await buffered.arrayBuffer()).byteLength, 500);

  const head = await fetcher(session).fetch("/assets/a.css", { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), "500");
  assert.equal(await head.text(), "", "HEAD has no body");
  assert.equal(streamCalls, 0, "neither path streamed");
});

test("a session without requestStream (an older client) still serves buffered bodies", async () => {
  const session: AssetRequester = {
    isOpen: true,
    request: async () => ({ body: bytes(64), headers: {} }),
  };
  const res = await fetcher(session).fetch("/assets/a.bin");
  assert.equal((await res.arrayBuffer()).byteLength, 64);
});

test("the scheduler stops granting a paused transfer, and its bytes still count as outstanding", () => {
  const s = new SrptScheduler({ budget: 10_000, minIncrement: 1000 });
  s.add(1n, 100_000, 4000, 0); // a big transfer, 4000 already granted
  s.add(2n, 50_000, 0, 0);

  s.setPaused(1n, true);
  const paused = s.grants();
  assert.deepEqual(paused.map((g) => g.rpcId), [2n], "only the unpaused transfer is granted");
  assert.equal(s.outstanding(), 4000 + (s.granted(2n) ?? 0), "the paused transfer's grant is still in flight");

  // Resuming makes it a candidate again; strict SRPT still serves the shorter
  // transfer first, so it is granted once that one is out of the way.
  s.setPaused(1n, false);
  s.onData(2n, s.granted(2n)!);
  s.remove(2n);
  assert.ok(s.grants().some((g) => g.rpcId === 1n), "resuming lets it be granted again");
});
