import { test } from "node:test";
import assert from "node:assert/strict";
import { Reassembly } from "../../client/src/reassembly.ts";

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

test("in-order chunks complete the asset", () => {
  const src = bytes(10);
  const r = new Reassembly(10);
  assert.equal(r.add(0, src.subarray(0, 4)), 4);
  assert.equal(r.contiguous, 4);
  assert.equal(r.add(4, src.subarray(4)), 6);
  assert.ok(r.complete);
  assert.deepEqual(r.bytes, src);
  assert.deepEqual(r.missing(), []);
});

test("out-of-order, duplicate and overlapping chunks count each byte once", () => {
  const src = bytes(20);
  const r = new Reassembly(20);
  assert.equal(r.add(10, src.subarray(10, 15)), 5);
  assert.equal(r.contiguous, 0);
  assert.deepEqual(r.missing(), [{ start: 0, end: 10 }, { start: 15, end: 20 }]);
  assert.equal(r.add(10, src.subarray(10, 15)), 0, "exact duplicate");
  assert.equal(r.add(8, src.subarray(8, 12)), 2, "overlaps the front");
  assert.equal(r.add(14, src.subarray(14, 17)), 2, "overlaps the back");
  assert.equal(r.add(0, src.subarray(0, 20)), 20 - 9, "covers everything");
  assert.ok(r.complete);
  assert.equal(r.received, 20);
  assert.deepEqual(r.bytes, src);
});

test("adjacent chunks merge", () => {
  const r = new Reassembly(6);
  r.add(0, bytes(2));
  r.add(4, bytes(2));
  assert.deepEqual(r.missing(), [{ start: 2, end: 4 }]);
  r.add(2, bytes(2));
  assert.equal(r.contiguous, 6);
  assert.deepEqual(r.missing(), []);
});

test("missing() stops at the limit", () => {
  const r = new Reassembly(100);
  r.add(10, bytes(10));
  assert.deepEqual(r.missing(15), [{ start: 0, end: 10 }]);
  assert.deepEqual(r.missing(40), [{ start: 0, end: 10 }, { start: 20, end: 40 }]);
});

test("empty asset is complete immediately", () => {
  const r = new Reassembly(0);
  assert.ok(r.complete);
  assert.equal(r.add(0, new Uint8Array(0)), 0);
});

test("a chunk outside the asset throws", () => {
  const r = new Reassembly(10);
  assert.throws(() => r.add(8, bytes(3)), RangeError);
  assert.throws(() => r.add(-1, bytes(1)), RangeError);
});

test("randomized: shuffled overlapping chunks with repeats reassemble exactly", () => {
  let seed = 42;
  const rand = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n);
  for (let round = 0; round < 200; round++) {
    const size = rand(5000);
    const src = bytes(size, round);
    const r = new Reassembly(size);
    const chunks: [number, number][] = [];
    for (let at = 0; at < size; ) {
      const n = 1 + rand(300);
      chunks.push([at, Math.min(size, at + n)]);
      at += n;
    }
    for (let k = 0; k < 20 && size > 0; k++) {
      const s = rand(size);
      chunks.push([s, Math.min(size, s + 1 + rand(400))]);
    }
    for (let i = chunks.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [chunks[i], chunks[j]] = [chunks[j]!, chunks[i]!];
    }
    let fresh = 0;
    for (const [s, e] of chunks) fresh += r.add(s, src.subarray(s, e));
    assert.equal(fresh, size, `round ${round}`);
    assert.ok(r.complete);
    assert.deepEqual(r.bytes, src);
  }
});
