// The TypeScript codec against the shared golden vectors (the Go codec runs
// the same file in server/internal/wire/wire_test.go), plus a randomized
// canonical-encoding check.
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, encode, maxPayload, newRpcId, MalformedPacketError, type Packet } from "../../client/src/wire.ts";

interface Vectors {
  valid: { name: string; hex: string; packet: Record<string, string | number> }[];
  invalid: { name: string; hex: string }[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../testdata/wire/vectors.json"), "utf8"),
);

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function packetFromJSON(m: Record<string, string | number>): Packet {
  const rpcId = BigInt("0x" + m.rpcId);
  switch (m.type) {
    case "REQ":
      return { type: "REQ", rpcId, initialGrant: m.initialGrant as number, assetId: m.assetId as string };
    case "DATA":
      return { type: "DATA", rpcId, totalSize: m.totalSize as number, offset: m.offset as number, payload: fromHex(m.payload as string) };
    case "GRANT":
      return { type: "GRANT", rpcId, maxOffset: m.maxOffset as number, priority: m.priority as number };
    case "RESEND":
      return { type: "RESEND", rpcId, start: m.start as number, end: m.end as number };
    case "ERROR":
      return { type: "ERROR", rpcId, code: m.code as number };
  }
  throw new Error(`unknown vector type ${m.type}`);
}

for (const v of vectors.valid) {
  test(`valid: ${v.name}`, () => {
    const want = packetFromJSON(v.packet);
    assert.deepEqual(decode(fromHex(v.hex)), want);
    assert.equal(toHex(encode(want)), v.hex);
  });
}

for (const v of vectors.invalid) {
  test(`invalid: ${v.name}`, () => {
    assert.throws(() => decode(fromHex(v.hex)), MalformedPacketError);
  });
}

test("decode reads a packet at a non-zero byteOffset", () => {
  const v = vectors.valid.find((x) => x.name === "grant_basic")!;
  const inner = fromHex(v.hex);
  const outer = new Uint8Array(inner.length + 3);
  outer.set(inner, 3);
  assert.deepEqual(decode(outer.subarray(3)), packetFromJSON(v.packet));
});

test("encode rejects what decode rejects", () => {
  const rpcId = 1n;
  const bad: Packet[] = [
    { type: "REQ", rpcId, initialGrant: 0, assetId: "" },
    { type: "REQ", rpcId, initialGrant: 0, assetId: "x".repeat(0x10000) },
    { type: "REQ", rpcId, initialGrant: 0, assetId: "\ud800" }, // lone surrogate
    { type: "REQ", rpcId, initialGrant: 2 ** 32, assetId: "a" },
    { type: "DATA", rpcId, totalSize: 2, offset: 1, payload: new Uint8Array(2) },
    { type: "GRANT", rpcId, maxOffset: -1, priority: 0 },
    { type: "GRANT", rpcId, maxOffset: 1.5, priority: 0 },
    { type: "GRANT", rpcId, maxOffset: 0, priority: 256 },
    { type: "GRANT", rpcId: 2n ** 64n, maxOffset: 0, priority: 0 },
    { type: "RESEND", rpcId, start: 5, end: 5 },
  ];
  for (const p of bad) assert.throws(() => encode(p), MalformedPacketError, JSON.stringify(p, (_, x) => (typeof x === "bigint" ? `${x}n` : x)));
});

test("maxPayload leaves room for the 17-byte DATA header", () => {
  assert.equal(maxPayload(1024), 1007);
  assert.equal(maxPayload(10), 0);
});

test("newRpcId returns distinct u64 values", () => {
  const ids = new Set(Array.from({ length: 1000 }, newRpcId));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.ok(id >= 0n && id < 2n ** 64n);
});

// Same property as Go's FuzzDecode: never an unexpected exception, and anything
// accepted re-encodes to the identical bytes. Inputs are valid vectors with
// random byte mutations plus fully random buffers, from a fixed seed.
test("randomized: decode is total and canonical", () => {
  let seed = 0x1234_5678;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const seeds = vectors.valid.map((v) => fromHex(v.hex));
  let accepted = 0;
  for (let i = 0; i < 200_000; i++) {
    let b: Uint8Array;
    if (i % 2 === 0) {
      b = Uint8Array.from(seeds[Math.floor(rand() * seeds.length)]!);
      const flips = 1 + Math.floor(rand() * 3);
      for (let f = 0; f < flips && b.length > 0; f++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
    } else {
      b = Uint8Array.from({ length: Math.floor(rand() * 40) }, () => Math.floor(rand() * 256));
    }
    let p: Packet;
    try {
      p = decode(b);
    } catch (e) {
      assert.ok(e instanceof MalformedPacketError, `unexpected ${e} for ${toHex(b)}`);
      continue;
    }
    accepted++;
    assert.equal(toHex(encode(p)), toHex(b));
  }
  assert.ok(accepted > 1000, `only ${accepted} inputs decoded; generator is too weak to mean anything`);
});
