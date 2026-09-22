// openDisabled (index.ts): the fallback-only handle a page gets with
// ?http4=off. It must never open a session, say why HTTP4 is unavailable, and
// hand every request to the platform fetch untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDisabled } from "../../client/src/index.ts";

test("a disabled handle has no session and says why", () => {
  const { handle, assetPrefix } = openDisabled("HTTP4 disabled for this page", { baseUrl: "https://site.example/" });
  assert.equal(handle.available, false);
  assert.equal(handle.unavailableReason, "HTTP4 disabled for this page");
  assert.equal(handle.client, undefined);
  assert.equal(assetPrefix, undefined);
});

test("a disabled handle passes every request to the platform fetch", async () => {
  const seen: string[] = [];
  const platform = (async (input: RequestInfo | URL) => {
    seen.push(String(input instanceof Request ? input.url : input));
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  const { handle } = openDisabled("off", { baseUrl: "https://site.example/", fetch: platform });
  const res = await handle.fetch("/style.css");
  assert.equal(await res.text(), "ok");
  assert.deepEqual(seen, ["/style.css"]); // the input, untouched
  assert.deepEqual(handle.report().map((r) => r.transport), ["platform"]);
});
