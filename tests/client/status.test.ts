import { test } from "node:test";
import assert from "node:assert/strict";
import { Http4Error, httpStatusFor } from "../../client/src/transport.ts";
import { ErrorCode } from "../../client/src/wire.ts";

test("httpStatusFor maps HTTP4 errors to HTTP statuses", () => {
  assert.equal(httpStatusFor(new Http4Error("x", ErrorCode.NOT_FOUND)), 404);
  assert.equal(httpStatusFor(new Http4Error("x", ErrorCode.BAD_REQUEST)), 400);
  assert.equal(httpStatusFor(new Http4Error("x", ErrorCode.UNKNOWN_RPC)), 503);
  assert.equal(httpStatusFor(new Http4Error("x", 0x7f)), 502, "unknown code");
  assert.equal(httpStatusFor(new Http4Error("stalled")), 502, "transport failure, no code");
  assert.equal(httpStatusFor(new TypeError("boom")), 502, "not an Http4Error");
});
