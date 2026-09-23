// Classification (vrek iss-j9tm9w8, Levels 0 and 2) and the scheduler
// ordering that acts on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classFor, classForDestination, classMap, CLASSES, classRank } from "../../client/src/priority.ts";
import { SrptScheduler } from "../../client/src/scheduler.ts";

test("Level 0: a class from the request's destination alone", () => {
  // Render-blocking: the page cannot paint without them.
  for (const d of ["style", "script", "font"]) assert.equal(classForDestination(d), "critical", d);
  // Bulk: nothing waits on them to become interactive.
  for (const d of ["image", "video", "audio", "track"]) assert.equal(classForDestination(d), "background", d);
  // The app is running by then and can say better at Level 2 or 3.
  for (const d of ["", "manifest", "worker", "embed", "anything-new"]) assert.equal(classForDestination(d), "normal", d);
});

test("Level 2: a config's class map, validated and longest-prefix-first", () => {
  const m = classMap({ "/images/": "background", "/images/hero": "critical", "/api/": "critical" });
  // Longest prefix wins whatever order the page wrote them in.
  assert.equal(classFor("/images/hero-1.jpg", "image", m), "critical");
  assert.equal(classFor("/images/gallery/9.jpg", "image", m), "background");
  assert.equal(classFor("/api/cart", "", m), "critical");
  // No rule matches: fall back to the destination's default.
  assert.equal(classFor("/app.js", "script", m), "critical");
  assert.equal(classFor("/photo.png", "image", m), "background");
});

test("Level 2 rules are an allowlist: a bad one costs that rule, not the session", () => {
  const m = classMap({
    "/good/": "critical",
    "/bad/": "urgent",        // not a class
    "relative": "critical",   // not a path prefix
    "/n/": 3,                 // not a string
    "/o/": null,
  });
  assert.deepEqual(m.map(([p]) => p), ["/good/"]);
  // Not an object at all.
  for (const bad of [null, undefined, 42, "x", ["/a/", "critical"]]) assert.deepEqual(classMap(bad), [], String(bad));
});

test("the scheduler grants by class first, and keeps SRPT inside a class", () => {
  const s = new SrptScheduler({ budget: 1_000_000, minIncrement: 1 });
  s.add(1n, 500_000, 0, 0, "background"); // smallest, but background
  s.add(2n, 900_000, 0, 0, "critical");   // largest, but critical
  s.add(3n, 700_000, 0, 0, "critical");
  const order = s.grants().map((g) => g.rpcId);
  // Critical before background, and within critical the shorter one first —
  // 700k before 900k, so SRPT applies inside the class only. The background
  // transfer gets nothing at all here: the two critical ones want 1.6 MB of a
  // 1 MB budget, so it waits, which is the whole point of the class.
  assert.deepEqual(order, [3n, 2n]);

  // Once the critical ones are done, background gets its turn — deferred, not
  // starved. (G6 aging is the guardrail for the case where they never finish.)
  s.remove(2n);
  s.remove(3n);
  assert.deepEqual(s.grants().map((g) => g.rpcId), [1n]);
});

test("with no classes given, ordering is exactly the SRPT it replaces", () => {
  const withClasses = new SrptScheduler({ budget: 1_000_000, minIncrement: 1 });
  const without = new SrptScheduler({ budget: 1_000_000, minIncrement: 1 });
  for (const [id, size] of [[1n, 900_000], [2n, 100_000], [3n, 500_000]] as const) {
    withClasses.add(id, size, 0, 0, "normal");
    without.add(id, size, 0, 0);
  }
  const a = without.grants().map((g) => g.rpcId);
  const b = withClasses.grants().map((g) => g.rpcId);
  assert.deepEqual(a, [2n, 3n, 1n], "shortest remaining first");
  assert.deepEqual(b, a, "one class everywhere must not change the order");
});

test("class ranks are the declared order, so 0 is the most urgent", () => {
  assert.deepEqual([...CLASSES], ["critical", "normal", "background"]);
  assert.deepEqual(CLASSES.map(classRank), [0, 1, 2]);
});
