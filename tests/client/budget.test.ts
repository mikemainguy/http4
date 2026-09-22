import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetController } from "../../client/src/budget.ts";

const KiB = 1024;
const MiB = 1024 * KiB;
const P = 1183; // server DATA payload per packet

interface Link {
  rttMs: number;
  bytesPerMs: number; // bottleneck rate
}

/**
 * A receiver-driven transfer over a simulated link: the receiver keeps up to
 * `ctl.budget` bytes granted-but-not-received, one packet at a time; each
 * granted packet leaves the sender after half an RTT (the GRANT's trip),
 * queues behind earlier ones at the bottleneck rate, and arrives half an RTT
 * later. Returns delivery times so tests can measure throughput.
 */
function simulate(ctl: BudgetController, link: Link, bytes: number, start = 0) {
  const inFlight: number[] = []; // arrival times, FIFO (departures are monotone)
  let lastDepart = start;
  let granted = 0;
  let delivered = 0;
  let t = start;
  const arrivals: number[] = [];
  ctl.onRttSample(link.rttMs, t);
  const refill = () => {
    while (granted < bytes && granted - delivered + P <= ctl.budget) {
      lastDepart = Math.max(t + link.rttMs / 2, lastDepart + P / link.bytesPerMs);
      inFlight.push(lastDepart + link.rttMs / 2);
      granted += P;
    }
    if (granted < bytes) ctl.noteLimited();
  };
  refill();
  while (inFlight.length > 0) {
    t = inFlight.shift()!;
    delivered += P;
    arrivals.push(t);
    ctl.onDelivered(P, t);
    refill();
  }
  return { end: t, arrivals };
}

/** Throughput in bytes/ms over the second half of a transfer, after ramp-up. */
function steadyRate(arrivals: number[]): number {
  const half = Math.floor(arrivals.length / 2);
  return ((arrivals.length - half) * P) / (arrivals.at(-1)! - arrivals[half]!);
}

test("before any RTT sample the budget is the floor", () => {
  const c = new BudgetController({ floor: 128 * KiB, cap: 16 * MiB });
  assert.equal(c.budget, 128 * KiB);
  c.onDelivered(10_000, 0);
  c.onDelivered(10_000, 50);
  assert.equal(c.budget, 128 * KiB, "no RTT, no BDP");
});

test("on a long fat path the budget ramps to ~2 BDP and fills the pipe", () => {
  const link = { rttMs: 150, bytesPerMs: 20_000 }; // 20 MB/s: BDP 3 MB
  const c = new BudgetController({ floor: 128 * KiB, cap: 16 * MiB });
  const { arrivals } = simulate(c, link, 50 * MiB);
  const bdp = link.rttMs * link.bytesPerMs;
  assert.ok(steadyRate(arrivals) > 0.95 * link.bytesPerMs, `steady ${steadyRate(arrivals).toFixed(0)} B/ms`);
  assert.ok(c.budget > 1.5 * bdp && c.budget < 2.5 * bdp, `budget ${c.budget} vs BDP ${bdp}`);
  // A fixed 128 KiB budget would run at budget ÷ RTT (~0.87 MB/s): ~60 s for 50 MiB.
  const lineRateMs = (50 * MiB) / link.bytesPerMs;
  assert.ok(arrivals.at(-1)! < lineRateMs + 12 * link.rttMs, `took ${arrivals.at(-1)!.toFixed(0)} ms vs ${lineRateMs.toFixed(0)} ms at line rate`);
});

test("ramp-up doubles per round trip while the budget is the limit", () => {
  const link = { rttMs: 50, bytesPerMs: 1_000_000 }; // effectively unlimited
  const c = new BudgetController({ floor: 128 * KiB, cap: 16 * MiB });
  const budgets: number[] = [];
  const orig = c.onDelivered.bind(c);
  c.onDelivered = (b, t) => {
    const before = c.budget;
    orig(b, t);
    if (c.budget !== before) budgets.push(c.budget);
  };
  simulate(c, link, 64 * MiB);
  assert.ok(budgets.length >= 5, `budget changed ${budgets.length} times`);
  for (let i = 1; i < 5; i++) {
    const g = budgets[i]! / budgets[i - 1]!;
    assert.ok(g > 1.5 && g <= 2.3, `step ${i}: ×${g.toFixed(2)} (${budgets.slice(0, 6).join(", ")})`);
  }
  assert.equal(Math.max(...budgets), 16 * MiB, "reaches the cap on an unlimited link");
});

test("on a short path the budget stays at the floor", () => {
  const c = new BudgetController({ floor: 128 * KiB, cap: 16 * MiB });
  simulate(c, { rttMs: 0.5, bytesPerMs: 100_000 }, 20 * MiB); // BDP 50 KB
  assert.equal(c.budget, 128 * KiB);
});

test("the budget never exceeds the cap", () => {
  const c = new BudgetController({ floor: 128 * KiB, cap: 1 * MiB });
  simulate(c, { rttMs: 150, bytesPerMs: 50_000 }, 30 * MiB);
  assert.equal(c.budget, 1 * MiB);
});

test("an idle gap doesn't shrink the estimate: the window counts delivery rounds, not time", () => {
  const link = { rttMs: 100, bytesPerMs: 10_000 };
  const c = new BudgetController({ floor: 128 * KiB, cap: 16 * MiB });
  const { end } = simulate(c, link, 20 * MiB);
  const warm = c.budget;
  assert.ok(warm > 1 * MiB);
  // 5 s later a small, app-limited request arrives: its low rate must not
  // pull the estimate down.
  simulate(c, link, 8 * KiB, end + 5000);
  assert.equal(c.budget, warm);
});

test("a loss shrinks the budget by 15% and holds growth for one round trip", () => {
  const link = { rttMs: 100, bytesPerMs: 10_000 };
  const c = new BudgetController({ floor: 128 * KiB, cap: 16 * MiB });
  const { end } = simulate(c, link, 20 * MiB);
  const before = c.budget;
  c.onLoss(end);
  assert.equal(c.budget, Math.floor(before * 0.85));
  // Deliveries within the hold can't raise it back...
  c.onDelivered(P, end + 1);
  c.onDelivered(10 * MiB, end + 50);
  assert.equal(c.budget, Math.floor(before * 0.85));
  // ...after it, it follows the estimate again.
  c.onDelivered(P, end + 200);
  c.onDelivered(P, end + 320);
  assert.ok(c.budget > Math.floor(before * 0.85));
});

test("the floor holds under repeated loss", () => {
  const c = new BudgetController({ floor: 128 * KiB, cap: 16 * MiB });
  for (let i = 0; i < 50; i++) c.onLoss(i);
  assert.equal(c.budget, 128 * KiB);
});

test("minRtt is the smallest recent sample, and ages out after 10 s", () => {
  const c = new BudgetController({ floor: 128 * KiB, cap: 16 * MiB });
  c.onRttSample(60, 0);
  c.onRttSample(50, 1000);
  c.onRttSample(80, 2000); // inflated by queueing: ignored
  assert.equal(c.minRttMs, 50);
  c.onRttSample(70, 12_000); // the 50 ms sample is over 10 s old
  assert.equal(c.minRttMs, 70);
});

test("k scales the target", () => {
  const link = { rttMs: 100, bytesPerMs: 10_000 }; // BDP 1 MB
  const k1 = new BudgetController({ floor: 64 * KiB, cap: 16 * MiB, k: 1 });
  const k3 = new BudgetController({ floor: 64 * KiB, cap: 16 * MiB, k: 3 });
  simulate(k1, link, 20 * MiB);
  simulate(k3, link, 20 * MiB);
  assert.ok(k3.budget > 2.5 * k1.budget, `k=1 → ${k1.budget}, k=3 → ${k3.budget}`);
});
