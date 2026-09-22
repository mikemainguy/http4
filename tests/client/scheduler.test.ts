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
  const s = new SrptScheduler({ budget: 100, minIncrement: 50 });
  s.add(1n, 1000, 60, 0); // 60 outstanding, only 40 free
  s.add(2n, 5000, 0, 0);
  assert.deepEqual(s.grants(), []);
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

// Simulated transfers: RPCs arrive over time, granted bytes arrive in random
// order and chunk sizes, and grants() runs after every event. Invariants:
// the budget is never exceeded, grants only rise and never pass the size,
// every grant goes to the RPC with the least remaining among those that can
// still take one, and every transfer finishes.
test("randomized: SRPT invariants hold across many interleaved transfers", () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n);
  let totalGrants = 0;
  let contendedGrants = 0; // grants made while another RPC could also have taken one
  for (let round = 0; round < 50; round++) {
    const trace: GrantTrace[] = [];
    const budget = 1000 + rand(50_000);
    const s = new SrptScheduler({ budget, minIncrement: 1 + rand(4000), trace });
    const size = new Map<bigint, number>();
    const granted = new Map<bigint, number>();
    const received = new Map<bigint, number>();
    let nextId = 1n;
    let pendingArrivals = 5 + rand(20);
    const apply = () => {
      const before = trace.length;
      for (const g of s.grants()) {
        assert.ok(g.maxOffset > granted.get(g.rpcId)!, "grants only rise");
        assert.ok(g.maxOffset <= size.get(g.rpcId)!, "grant within size");
        granted.set(g.rpcId, g.maxOffset);
      }
      for (const t of trace.slice(before)) {
        assert.ok(t.others.every((o) => o >= t.remaining), `grant to ${t.remaining} left while ${t.others} could still take one`);
      }
      let out = 0;
      for (const [id, g] of granted) out += g - received.get(id)!;
      assert.ok(out <= budget, `outstanding ${out} > budget ${budget}`);
    };
    for (let step = 0; step < 100_000; step++) {
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
