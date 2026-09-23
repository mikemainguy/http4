import { test } from "node:test";
import assert from "node:assert/strict";
import { SrptScheduler, type GrantTrace } from "../../client/src/scheduler.ts";

test("a single RPC is granted up to the budget, then more as data arrives", () => {
  const s = new SrptScheduler({ budget: 100, minIncrement: 10 });
  s.add(1n, 1000, 0, 0);
  assert.deepEqual(s.grants(), [{ rpcId: 1n, maxOffset: 100, priority: 0 }]);
  assert.deepEqual(s.grants(), [], "budget is full");
  s.onData(1n, 50);
  assert.deepEqual(s.grants(), [{ rpcId: 1n, maxOffset: 150, priority: 0 }]);
});

test("the shortest remaining RPC is fully granted before a longer one gets anything", () => {
  const trace: GrantTrace[] = [];
  const s = new SrptScheduler({ budget: 300, minIncrement: 10, trace });
  s.add(1n, 1000, 0, 0);
  s.add(2n, 200, 0, 0);
  assert.deepEqual(s.grants(), [
    { rpcId: 2n, maxOffset: 200, priority: 0 },
    { rpcId: 1n, maxOffset: 100, priority: 1 },
  ]);
  assert.deepEqual(trace.map((t) => [t.rpcId, t.remaining, t.others]), [
    [2n, 200, [1000]],
    [1n, 1000, []],
  ]);
});

test("remaining, not total size, decides the order", () => {
  const s = new SrptScheduler({ budget: 100, minIncrement: 1 });
  s.add(1n, 1000, 950, 950); // 50 left
  s.add(2n, 200, 0, 0); // 200 left
  assert.equal(s.grants()[0]!.rpcId, 1n);
});

test("strict SRPT: if the shortest can't take minIncrement, nobody longer gets a grant", () => {
  // The ratio matters: minIncrement is capped at a quarter of the budget, so
  // the original 50-of-100 here was the very case that cap exists to prevent
  // and no longer withholds. The rule under test is unchanged — free space
  // below minIncrement withholds from everyone — only the numbers are now a
  // ratio a real session could have.
  const s = new SrptScheduler({ budget: 1000, minIncrement: 50 });
  // Big enough that the 40 free bytes can't complete it, which would be
  // allowed regardless of minIncrement.
  s.add(1n, 5000, 960, 0); // 960 outstanding, only 40 free
  s.add(2n, 9000, 0, 0);
  assert.deepEqual(s.grants(), []);
});

test("minIncrement is capped at a share of the budget, so a bad setting slows grants rather than stopping them", () => {
  // 64 KiB against the 128 KiB floor was enough to make a live site crawl:
  // `available` is what is left after reserved and in-flight bytes, so it
  // rarely reached the increment and grants were withheld almost always.
  const s = new SrptScheduler({ budget: 128 * 1024, minIncrement: 64 * 1024 });
  s.add(1n, 5_000_000, 0, 0);
  s.onData(1n, 0);
  // 40 KiB free is under the configured 64 KiB but over the capped 32 KiB.
  s.add(2n, 5_000_000, 128 * 1024 - 40 * 1024, 0);
  const gs = s.grants();
  assert.ok(gs.length > 0, "a grant must still be issued with 40 KiB free");
});

test("a grant smaller than minIncrement is allowed if it completes the RPC", () => {
  const s = new SrptScheduler({ budget: 100, minIncrement: 50 });
  s.add(1n, 30, 0, 0);
  assert.deepEqual(s.grants(), [{ rpcId: 1n, maxOffset: 30, priority: 0 }]);
});

test("reserved budget (REQs whose size is unknown) is not handed out", () => {
  const s = new SrptScheduler({ budget: 100, minIncrement: 1 });
  s.add(1n, 1000, 0, 0);
  assert.deepEqual(s.grants(70), [{ rpcId: 1n, maxOffset: 30, priority: 0 }]);
});

test("the initial grant counts, and is capped at the size", () => {
  const s = new SrptScheduler({ budget: 100, minIncrement: 1 });
  s.add(1n, 10, 4096, 0);
  assert.equal(s.outstanding(), 10);
  assert.deepEqual(s.grants(), []);
});

test("a shrunk budget hands out nothing until enough has arrived; a grown one hands out more", () => {
  const s = new SrptScheduler({ budget: 100, minIncrement: 1 });
  s.add(1n, 1000, 0, 0);
  assert.deepEqual(s.grants(), [{ rpcId: 1n, maxOffset: 100, priority: 0 }]);
  s.setBudget(40); // 100 outstanding: nothing is revoked
  assert.deepEqual(s.grants(), []);
  s.onData(1n, 80); // 20 outstanding, 20 free
  assert.deepEqual(s.grants(), [{ rpcId: 1n, maxOffset: 120, priority: 0 }]);
  s.setBudget(500);
  assert.deepEqual(s.grants(), [{ rpcId: 1n, maxOffset: 580, priority: 0 }]);
});

test("budgetLimited: set when a transfer still wants more and the budget ran out", () => {
  const s = new SrptScheduler({ budget: 100, minIncrement: 10 });
  s.add(1n, 1000, 0, 0);
  s.grants();
  assert.equal(s.budgetLimited, true, "900 bytes still wanted, no room");
  const t = new SrptScheduler({ budget: 5000, minIncrement: 10 });
  t.add(1n, 1000, 0, 0);
  t.grants();
  assert.equal(t.budgetLimited, false, "everything granted with room to spare");
  assert.equal(new SrptScheduler({ budget: 100, minIncrement: 10 }).grants().length, 0);
});

// Simulated transfers: RPCs arrive over time, granted bytes arrive in random
// order and chunk sizes, the budget changes at random (as the BDP estimate
// moves, sometimes below what is outstanding), and grants() runs after every
// event. Invariants: a grants() call never raises outstanding above the
// current budget, grants only rise and never pass the size, every grant goes
// to the RPC with the least remaining among those that can still take one,
// and every transfer finishes.
test("randomized: SRPT invariants hold across many interleaved transfers", () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n);
  let totalGrants = 0;
  let contendedGrants = 0; // grants made while another RPC could also have taken one
  for (let round = 0; round < 50; round++) {
    const trace: GrantTrace[] = [];
    let budget = 1000 + rand(50_000);
    const s = new SrptScheduler({ budget, minIncrement: 1 + rand(4000), trace });
    const size = new Map<bigint, number>();
    const granted = new Map<bigint, number>();
    const received = new Map<bigint, number>();
    let nextId = 1n;
    let pendingArrivals = 5 + rand(20);
    const outstanding = () => {
      let out = 0;
      for (const [id, g] of granted) out += g - received.get(id)!;
      return out;
    };
    const apply = () => {
      const before = trace.length;
      const outBefore = outstanding();
      for (const g of s.grants()) {
        assert.ok(g.maxOffset > granted.get(g.rpcId)!, "grants only rise");
        assert.ok(g.maxOffset <= size.get(g.rpcId)!, "grant within size");
        granted.set(g.rpcId, g.maxOffset);
      }
      for (const t of trace.slice(before)) {
        assert.ok(t.others.every((o) => o >= t.remaining), `grant to ${t.remaining} left while ${t.others} could still take one`);
      }
      const out = outstanding();
      assert.ok(out <= Math.max(budget, outBefore), `outstanding ${out} > budget ${budget} (was ${outBefore})`);
    };
    for (let step = 0; step < 100_000; step++) {
      if (rand(50) === 0) {
        budget = 1000 + rand(200_000);
        s.setBudget(budget);
      }
      if (pendingArrivals > 0 && rand(4) === 0) {
        const id = nextId++;
        const n = rand(200_000);
        size.set(id, n);
        granted.set(id, 0);
        received.set(id, 0);
        s.add(id, n, 0, 0);
        pendingArrivals--;
      } else {
        // Deliver a random chunk of some RPC's granted-but-unreceived bytes.
        const open = [...granted].filter(([id, g]) => g > received.get(id)!);
        if (open.length === 0) {
          if (pendingArrivals === 0 && [...received].every(([id, r]) => r === size.get(id))) break;
          apply();
          continue;
        }
        const [id, g] = open[rand(open.length)]!;
        const n = Math.min(g - received.get(id)!, 1 + rand(1200));
        received.set(id, received.get(id)! + n);
        s.onData(id, n);
        if (received.get(id) === size.get(id)) s.remove(id);
      }
      apply();
    }
    for (const [id, n] of size) assert.equal(received.get(id), n, `round ${round}: rpc ${id} unfinished`);
    totalGrants += trace.length;
    contendedGrants += trace.filter((t) => t.others.length > 0).length;
  }
  // Guard against a generator that never creates contention.
  assert.ok(totalGrants > 1000 && contendedGrants > 500, `grants ${totalGrants}, contended ${contendedGrants}`);
  console.log(`scheduler simulation: ${totalGrants} grants, ${contendedGrants} under contention`);
});

// A minIncrement larger than the budget can ever free used to deadlock: no
// grant was worth issuing, so no data arrived, so the budget never grew, so no
// grant was issued. Suggested as a tuning value, it wedged a live site (vrek
// iss-pjpnk4q). Whatever the settings, a session with nothing in flight must
// always be able to make progress.
test("a minIncrement larger than the budget still makes progress", () => {
  const s = new SrptScheduler({ budget: 128 * 1024, minIncrement: 256 * 1024 });
  s.add(1n, 5_000_000, 0, 0); // far larger than the budget

  let granted = 0;
  let received = 0;
  for (let round = 0; round < 200 && received < 5_000_000; round++) {
    const gs = s.grants(0);
    if (gs.length === 0) {
      assert.fail(`no grant issued at round ${round} with ${received} of 5000000 received: deadlocked`);
    }
    for (const g of gs) {
      assert.ok(g.maxOffset > granted, "a grant must advance the ceiling");
      const fresh = g.maxOffset - granted;
      granted = g.maxOffset;
      received += fresh;
      s.onData(g.rpcId, fresh);
    }
  }
  assert.equal(received, 5_000_000, "the transfer must complete despite the oversized minIncrement");
});

test("the progress exception does not weaken strict SRPT while data is in flight", () => {
  const s = new SrptScheduler({ budget: 100_000, minIncrement: 16_384 });
  s.add(1n, 1_000_000, 0, 0);
  s.add(2n, 2_000_000, 0, 0);
  // First round: the budget is spent on the shortest, as SRPT requires.
  const first = s.grants(0);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.rpcId, 1n);
  // With bytes outstanding and less than minIncrement free, nobody gets a
  // dribble — the exception must not fire here.
  assert.deepEqual(s.grants(0), []);
  s.onData(1n, 1000); // frees only 1000 bytes, under minIncrement
  assert.deepEqual(s.grants(0), [], "a sub-minIncrement top-up is still withheld while data is in flight");
});
