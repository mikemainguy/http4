// Keeps the Phase 2 matrix runner (tests/matrix/run.ts) from rotting: runs it
// on one clean and one lossy cell with only the small fixtures, and checks it
// exits 0 with a well-formed G5 result. The official score is `npm run matrix`.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { root } from "../support/harness.ts";

test("matrix runner scores a clean and a lossy cell", () => {
  const r = spawnSync(
    process.execPath,
    [path.join(root, "tests/matrix/run.ts"), "--cells", "0x0,1x50", "--max-size", String(64 << 10), "--max-total-s", "240"],
    { encoding: "utf8", timeout: 300_000 },
  );
  assert.equal(r.status, 0, `runner exited ${r.status}:\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.suite, "phase2-matrix");
  assert.equal(out.g5_pct_cells_passing, 100);
  assert.equal(out.full_pool, false);
  assert.deepEqual(out.cells.map((c: { cell: string }) => c.cell), ["0x0", "1x50"]);
  for (const c of out.cells) {
    assert.equal(c.g1_pct_intact, 100, `${c.cell}: ${JSON.stringify(c.failures)}`);
    assert.equal(c.g2_ungranted_bytes, 0);
    assert.ok(c.client && c.proxy && c.server, `${c.cell} is missing stats`);
  }
  const lossy = out.cells[1];
  assert.ok(lossy.client.srttMs >= 45, `srtt ${lossy.client.srttMs} ms should reflect the 50 ms added RTT`);
  console.log(`matrix quick run: ${out.cells.map((c: { cell: string; seconds: { total: number } }) => `${c.cell} ${c.seconds.total.toFixed(1)} s`).join(", ")}`);
});
