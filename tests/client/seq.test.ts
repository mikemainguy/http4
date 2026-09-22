import { test } from "node:test";
import assert from "node:assert/strict";
import { SeqTracker } from "../../client/src/reassembly.ts";
import { decode, encode, MalformedPacketError } from "../../client/src/wire.ts";

test("numbers in order are all new; nothing is missing", () => {
  const s = new SeqTracker();
  for (let i = 0; i < 10; i++) assert.equal(s.arrive(i, 0), "new");
  assert.equal(s.top, 9);
  assert.equal(s.outstanding, 0);
  assert.deepEqual(s.detect(100, 3, 1), []);
});

test("a skipped number is lost only after `allowance` later numbers and the reordering window", () => {
  const s = new SeqTracker();
  s.arrive(0, 0);
  s.arrive(2, 0); // 1 is missing
  assert.deepEqual(s.detect(10, 3, 5), [], "only 1 later number: could be reordering");
  s.arrive(3, 1);
  s.arrive(4, 1);
  assert.deepEqual(s.detect(4, 3, 5), [], "3 later numbers, but still inside the window");
  assert.deepEqual(s.detect(5, 3, 5), [{ start: 1, end: 2 }]);
  assert.deepEqual(s.detect(100, 3, 5), [], "claimed: never requested twice");
});

test("a reordered number that arrives inside the window is not a loss", () => {
  const s = new SeqTracker();
  s.arrive(0, 0);
  s.arrive(5, 0);
  assert.equal(s.arrive(3, 1), "reordered");
  const lost = s.detect(100, 1, 5);
  assert.deepEqual(lost, [{ start: 1, end: 3 }, { start: 4, end: 5 }]);
});

test("a claimed number that arrives after all is spurious, then a duplicate", () => {
  const s = new SeqTracker();
  s.arrive(0, 0);
  s.arrive(4, 0);
  s.detect(10, 1, 0);
  assert.equal(s.arrive(2, 11), "spurious");
  assert.equal(s.arrive(2, 12), "duplicate");
  assert.equal(s.arrive(0, 12), "duplicate");
});

test("contiguous lost numbers merge into one RESEND_SEQ range, capped at maxRange", () => {
  const s = new SeqTracker();
  s.arrive(0, 0);
  s.arrive(11, 0); // 1..10 missing
  assert.deepEqual(s.detect(10, 1, 0, Infinity, 4), [
    { start: 1, end: 5 },
    { start: 5, end: 9 },
    { start: 9, end: 11 },
  ]);
});

test("the first number seen need not be 0: earlier numbers count as missing", () => {
  const s = new SeqTracker();
  s.arrive(3, 0);
  assert.equal(s.outstanding, 3);
  assert.deepEqual(s.detect(10, 1, 0), [{ start: 0, end: 3 }]);
});

test("a claimed number is asked for again after the delay, up to maxTries, unless it arrived", () => {
  const s = new SeqTracker();
  s.arrive(0, 0);
  s.arrive(3, 0); // 1, 2 missing
  assert.deepEqual(s.detect(10, 1, 0), [{ start: 1, end: 3 }]);
  assert.deepEqual(s.repeats(15, 10, 3), [], "not yet due");
  assert.deepEqual(s.repeats(20, 10, 3), [{ start: 1, end: 3 }], "second try");
  s.arrive(2, 21); // the original of 2 turns up after all
  assert.deepEqual(s.repeats(30, 10, 3), [{ start: 1, end: 2 }], "third and last try, for 1 only");
  assert.deepEqual(s.repeats(100, 10, 3), [], "maxTries reached");
});

test("a jump past MAX_GAP is not treated as a burst of losses", () => {
  const s = new SeqTracker();
  s.arrive(0, 0);
  s.arrive(SeqTracker.MAX_GAP + 100, 0);
  assert.equal(s.outstanding, 0);
});

// Every loss is eventually requested exactly once per number, and repairs
// (which arrive as new, higher numbers) that are lost again show up as new
// missing numbers of their own.
test("randomized: every lost number is requested once; late originals are spurious, never lost twice", () => {
  let seed = 3;
  const rand = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n);
  for (let round = 0; round < 100; round++) {
    const s = new SeqTracker();
    const requested = new Set<number>();
    let now = 0;
    const late: number[] = [];
    for (let seq = 0; seq < 2000; seq++) {
      now += 1;
      if (rand(20) === 0) continue; // lost
      if (rand(30) === 0) {
        late.push(seq); // delayed: arrives later
        continue;
      }
      s.arrive(seq, now);
      if (late.length && rand(3) === 0) s.arrive(late.shift()!, now);
      for (const r of s.detect(now, 3, 4)) {
        for (let x = r.start; x < r.end; x++) {
          assert.ok(!requested.has(x), `round ${round}: ${x} requested twice`);
          requested.add(x);
        }
      }
    }
    for (const x of late) s.arrive(x, now);
    for (const r of s.detect(now + 1000, 3, 4)) for (let x = r.start; x < r.end; x++) requested.add(x);
    // Whatever was never delivered is either requested or within the last `allowance` numbers.
    assert.ok(s.outstanding <= 3, `round ${round}: ${s.outstanding} numbers never requested`);
  }
});

test("codec: v2 packets round-trip; an old decoder's view is simulated by the unknown-type rule", () => {
  const hello = encode({ type: "HELLO", rpcId: 0n, caps: 1 });
  assert.deepEqual(decode(hello), { type: "HELLO", rpcId: 0n, caps: 1 });
  const ds = encode({ type: "DATA_SEQ", rpcId: 5n, totalSize: 3, offset: 0, seq: 7, payload: new Uint8Array([1, 2, 3]) });
  const back = decode(ds);
  assert.equal(back.type, "DATA_SEQ");
  // A future type this decoder doesn't know is rejected as malformed, which
  // the transport drops without failing the session: the same path a v1
  // peer takes for HELLO, DATA_SEQ and RESEND_SEQ.
  const future = new Uint8Array(13);
  future[0] = 0x0a;
  assert.throws(() => decode(future), MalformedPacketError);
});
