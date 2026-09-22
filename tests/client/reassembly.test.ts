import { test } from "node:test";
import assert from "node:assert/strict";
import { Reassembly, RepairTracker } from "../../client/src/reassembly.ts";

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

test("frontier is one past the highest byte received", () => {
  const r = new Reassembly(100);
  assert.equal(r.frontier, 0);
  r.add(40, bytes(10));
  assert.equal(r.frontier, 50);
  r.add(0, bytes(5));
  assert.equal(r.frontier, 50);
});

// [0, 20) and [30, 70) have arrived: [20, 30) was skipped over.
function withGap(): Reassembly {
  const r = new Reassembly(100);
  r.add(0, bytes(20));
  r.add(30, bytes(40));
  return r;
}

test("a skipped-over gap is RESENT only after the reordering window", () => {
  const asm = withGap();
  const t = new RepairTracker();
  assert.deepEqual(t.detect(asm, 40, 0, 5, 50), [], "first seen: a suspect, not yet lost");
  assert.deepEqual(t.detect(asm, 40, 4, 5, 50), [], "still inside the window");
  assert.deepEqual(t.detect(asm, 40, 5, 5, 50), [{ start: 20, end: 30 }]);
  assert.ok(t.requested);
});

test("only the part of a gap below the reorder limit is a suspect", () => {
  const asm = withGap();
  const t = new RepairTracker();
  assert.deepEqual(t.detect(asm, 20, 0, 0, 50), [], "limit at the gap's start: not skipped by enough");
  assert.deepEqual(t.detect(asm, 25, 0, 0, 50), [{ start: 20, end: 25 }]);
});

test("a late original fills the gap inside the window: nothing is RESENT", () => {
  const asm = withGap();
  const t = new RepairTracker();
  t.detect(asm, 40, 0, 5, 50);
  asm.add(20, bytes(10));
  assert.deepEqual(t.detect(asm, 40, 10, 5, 50), []);
  assert.ok(!t.requested);
});

test("a RESENT range isn't requested again until its delay passes", () => {
  const asm = withGap();
  const t = new RepairTracker();
  t.detect(asm, 40, 0, 0, 50);
  assert.deepEqual(t.detect(asm, 40, 10, 0, 50), [], "repair still due");
  assert.deepEqual(t.detect(asm, 40, 49, 0, 50), []);
  assert.deepEqual(t.detect(asm, 40, 50, 0, 50), [{ start: 20, end: 30 }], "overdue: the repair was lost too");
});

test("claim (the stall timer) skips what a live RESEND covers and records the rest", () => {
  const asm = new Reassembly(100);
  asm.add(0, bytes(10));
  asm.add(90, bytes(10)); // missing [10, 90)
  const t = new RepairTracker();
  assert.deepEqual(t.claim(asm, [{ start: 30, end: 40 }], 0, 100), [{ start: 30, end: 40 }]);
  assert.deepEqual(t.claim(asm, [{ start: 10, end: 90 }], 1, 100), [
    { start: 10, end: 30 },
    { start: 40, end: 90 },
  ]);
  assert.deepEqual(t.claim(asm, [{ start: 10, end: 90 }], 2, 100), [], "all of it is on its way");
  // The callers pass asm.missing(): once [30, 40) is repaired it simply isn't
  // asked about, and the rest is still covered by its live RESENDs.
  asm.add(30, bytes(10));
  assert.deepEqual(t.claim(asm, asm.missing(90), 3, 100), []);
  assert.deepEqual(t.claim(asm, asm.missing(90), 101, 100), [
    { start: 10, end: 30 },
    { start: 40, end: 90 },
  ], "after the delay the unrepaired ranges are due again");
});

test("randomized: repairs never overlap a live RESEND, and every aged gap gets requested", () => {
  let seed = 11;
  const rand = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n);
  for (let round = 0; round < 100; round++) {
    const size = 1 + rand(20_000);
    const asm = new Reassembly(size);
    const t = new RepairTracker();
    const live: { start: number; end: number; due: number }[] = [];
    let now = 0;
    // Deliver a random ~90% of the 100-byte packets, out of order.
    const packets = Array.from({ length: Math.ceil(size / 100) }, (_, i) => i).filter(() => rand(10) > 0);
    for (let i = packets.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [packets[i], packets[j]] = [packets[j]!, packets[i]!];
    }
    const src = bytes(size, round);
    for (const p of packets) {
      asm.add(p * 100, src.subarray(p * 100, Math.min(size, p * 100 + 100)));
      now += 1;
      for (const r of t.detect(asm, asm.frontier - 300, now, 3, 20)) {
        for (const l of live) {
          if (l.due > now) assert.ok(r.end <= l.start || l.end <= r.start, `round ${round}: ${JSON.stringify(r)} overlaps live ${JSON.stringify(l)}`);
        }
        live.push({ ...r, due: now + 20 });
      }
    }
    // Once everything has aged past the window and the delay, every gap below
    // the limit is requested (again, if its repair never came).
    now += 1000;
    const want = asm.missing(asm.frontier - 300);
    assert.deepEqual(t.detect(asm, asm.frontier - 300, now, 3, 20), want, `round ${round}`);
  }
});
