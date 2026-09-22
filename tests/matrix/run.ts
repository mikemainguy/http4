// Phase 2 matrix runner (vrek iss-a0knh54). Scores G5: the % of cells in the
// impairment matrix loss {0, 1, 5}% × RTT {0, 50, 150} ms where both Phase 1
// goals hold end to end in headless Chrome:
//
//   G1  every fetch's bytes match the manifest SHA-256
//   G2  the server sends 0 payload bytes past a grant
//
// Every cell runs in isolation: a fresh server, a fresh impairment proxy
// (server/cmd/impair) in front of its WebTransport port, and a fresh browser.
// The proxy adds the cell's RTT (split evenly between directions) and its loss
// rate in BOTH directions, seeded per cell, so a cell is reproducible. The
// fixture pool (scripts/gen-fixtures) is fetched one asset at a time, then all
// at once, as in the integrity suite.
//
// G5 is a correctness score (dec-smr579z): each cell's deadline is a
// hang guard, not a speed target (see cellDeadlineMs). Anything unfinished by
// then fails with a reason. Speed under loss is measured separately, against
// HTTP/3 on the same path. The whole run is also capped (--max-total-s,
// default 3 h): a cell starts only if at least MIN_CELL_MS of the budget is
// left, and its deadline is clamped to what remains; cells that can't start
// are reported as skipped and fail. Lossy high-RTT cells are genuinely slow
// (QUIC's loss-based congestion control, fnd-sp6a32v), so a full-pool run takes
// on the order of an hour; use --max-size for quick runs. The result goes to
// stdout as one JSON object; progress goes to stderr. Exits 1 unless every
// cell passes.
//
//   npm run matrix [-- --out results.json] [--cells 0x0,1x50] [--max-size BYTES] [--max-total-s S]
//
// --cells picks a subset as <loss %>x<RTT ms>. --max-size leaves out fixtures
// larger than BYTES for quick runs; the official score uses the full pool.
import { writeFileSync } from "node:fs";
import { startHarness, type ImpairStats, type ServerMetrics } from "../support/harness.ts";
import { openPage } from "../support/page.ts";
import { cellDeadlineMs, ensureFixtures, fetchBy, FIXTURES, Judge, log, type Failure, type Manifest } from "../support/suite.ts";
import type { ClientStats } from "../../client/src/transport.ts";

const LOSSES = [0, 1, 5]; // % per direction
const RTTS = [0, 50, 150]; // ms, added round trip

interface Cell {
  lossPct: number;
  rttMs: number;
}

interface CellResult extends Cell {
  cell: string; // "<loss>x<rtt>"
  pass: boolean;
  skipped?: string;
  g1_pct_intact: number;
  g2_ungranted_bytes: number;
  fetches: number;
  intact: number;
  failures: Failure[];
  deadline_s: number;
  seconds: { single: number; concurrent: number; total: number };
  client: Pick<ClientStats, "recoveries" | "resendsSent" | "reqRetransmits" | "duplicateBytesIn" | "srttMs" | "budget"> | null;
  proxy: { up_dropped: number; down_dropped: number; up_in: number; down_in: number } | null;
  server: Pick<ServerMetrics, "rpcs" | "data_packets" | "data_bytes" | "resent_bytes"> | null;
}

const cellName = (c: Cell) => `${c.lossPct}x${c.rttMs}`;

const MIN_CELL_MS = 60_000; // don't start a cell with less of the total budget left

async function runCell(manifest: Manifest, c: Cell, seed: number, deadlineMs: number): Promise<CellResult> {
  const deadlineS = deadlineMs / 1000;
  const j = new Judge(manifest, `cell deadline (${deadlineS.toFixed(0)} s) exceeded`);
  const impair = ["-rtt", `${c.rttMs}ms`, "-loss", String(c.lossPct / 100), "-seed", String(seed)];
  const started = performance.now();
  const deadline = started + deadlineMs;
  const h = await startHarness(FIXTURES, [], { impair });
  let proxyStats: ImpairStats | undefined;
  let client: CellResult["client"] = null;
  let server: CellResult["server"] = null;
  let g2 = 0;
  let single = 0;
  let concurrent = 0;
  try {
    const page = await h.browser.newPage();
    await openPage(page, h.http);
    const names = manifest.assets.map((a) => a.name);

    let t0 = performance.now();
    for (const name of names) j.judge("single", [name], await fetchBy(deadline, page, [name]));
    single = (performance.now() - t0) / 1000;

    t0 = performance.now();
    j.judge("concurrent", names, await fetchBy(deadline, page, names));
    concurrent = (performance.now() - t0) / 1000;

    const s = await page.evaluate(() => {
      const h = window.__http4;
      return h && !("error" in h) ? h.stats() : null;
    });
    if (s) {
      const { recoveries, resendsSent, reqRetransmits, duplicateBytesIn, srttMs, budget } = s;
      client = { recoveries, resendsSent, reqRetransmits, duplicateBytesIn, srttMs, budget };
    }
    const m = await h.metrics();
    g2 = m.ungranted_bytes_sent;
    server = { rpcs: m.rpcs, data_packets: m.data_packets, data_bytes: m.data_bytes, resent_bytes: m.resent_bytes };
  } finally {
    proxyStats = await h.stop();
  }
  const g1 = j.fetches ? (100 * j.intact) / j.fetches : 0;
  return {
    ...c,
    cell: cellName(c),
    pass: g1 === 100 && g2 === 0,
    g1_pct_intact: g1,
    g2_ungranted_bytes: g2,
    fetches: j.fetches,
    intact: j.intact,
    failures: j.failures,
    deadline_s: deadlineS,
    seconds: { single, concurrent, total: (performance.now() - started) / 1000 },
    client,
    proxy: proxyStats
      ? { up_in: proxyStats.up.in, up_dropped: proxyStats.up.dropped_loss, down_in: proxyStats.down.in, down_dropped: proxyStats.down.dropped_loss }
      : null,
    server,
  };
}

function skippedCell(manifest: Manifest, c: Cell, why: string): CellResult {
  const n = 2 * manifest.assets.length;
  return {
    ...c,
    cell: cellName(c),
    pass: false,
    skipped: why,
    g1_pct_intact: 0,
    g2_ungranted_bytes: 0,
    fetches: n,
    intact: 0,
    failures: [{ name: "*", phase: "all", reason: why }],
    deadline_s: 0,
    seconds: { single: 0, concurrent: 0, total: 0 },
    client: null,
    proxy: null,
    server: null,
  };
}

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const all = LOSSES.flatMap((lossPct) => RTTS.map((rttMs) => ({ lossPct, rttMs })));
  const cellsArg = get("--cells");
  const cells = cellsArg
    ? cellsArg.split(",").map((s) => {
        const m = /^(\d+(?:\.\d+)?)x(\d+)$/.exec(s.trim());
        if (!m) throw new Error(`--cells: "${s}" is not <loss %>x<RTT ms>`);
        return { lossPct: Number(m[1]), rttMs: Number(m[2]) };
      })
    : all;
  const maxSize = get("--max-size");
  return {
    out: get("--out"),
    cells,
    maxSize: maxSize === undefined ? Infinity : Number(maxSize),
    maxTotalMs: 1000 * Number(get("--max-total-s") ?? 3 * 3600),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const full = ensureFixtures();
  const manifest: Manifest = { assets: full.assets.filter((a) => a.size <= args.maxSize) };
  const bytes = manifest.assets.reduce((n, a) => n + a.size, 0);
  const fetches = 2 * manifest.assets.length;
  const fullPool = manifest.assets.length === full.assets.length;
  log(`${manifest.assets.length} fixtures (${fullPool ? "full pool" : "subset"}), ${(bytes / 2 ** 20).toFixed(1)} MiB; ${args.cells.length} cells`);

  const runStart = performance.now();
  const cells: CellResult[] = [];
  for (const [i, c] of args.cells.entries()) {
    const left = args.maxTotalMs - (performance.now() - runStart);
    const deadlineMs = Math.min(cellDeadlineMs(c, bytes, fetches), left);
    if (left < MIN_CELL_MS) {
      log(`cell ${cellName(c)}: skipped, total cap (${args.maxTotalMs / 1000} s) would be exceeded`);
      cells.push(skippedCell(manifest, c, `total runtime cap (${args.maxTotalMs / 1000} s) reached before this cell`));
      continue;
    }
    log(`cell ${cellName(c)} (loss ${c.lossPct}% each way, RTT +${c.rttMs} ms; deadline ${(deadlineMs / 1000).toFixed(0)} s)…`);
    const r = await runCell(manifest, c, 1000 + i, deadlineMs);
    log(
      `  ${r.pass ? "PASS" : "FAIL"}: ${r.intact}/${r.fetches} intact, ${r.g2_ungranted_bytes} un-granted bytes, ` +
        `single ${r.seconds.single.toFixed(2)} s, concurrent ${r.seconds.concurrent.toFixed(2)} s, ` +
        `recoveries ${r.client?.recoveries ?? "?"}, resends ${r.client?.resendsSent ?? "?"}, duplicate ${r.client?.duplicateBytesIn ?? "?"} B, ` +
        `proxy dropped ${r.proxy ? `${r.proxy.up_dropped} up / ${r.proxy.down_dropped} down` : "?"}`,
    );
    cells.push(r);
  }

  const passing = cells.filter((c) => c.pass).length;
  const result = {
    suite: "phase2-matrix",
    at: new Date().toISOString(),
    g5_pct_cells_passing: cells.length ? (100 * passing) / cells.length : 0,
    cells_passing: passing,
    cells_total: cells.length,
    full_pool: fullPool,
    fixtures: manifest.assets.length,
    fixture_bytes: bytes,
    runtime_s: (performance.now() - runStart) / 1000,
    cells,
  };
  const json = JSON.stringify(result, null, 2);
  process.stdout.write(json + "\n");
  if (args.out) writeFileSync(args.out, json + "\n");

  log(`${passing === cells.length ? "PASS" : "FAIL"}: G5 = ${result.g5_pct_cells_passing.toFixed(1)}% (${passing}/${cells.length} cells), ${result.runtime_s.toFixed(0)} s`);
  return passing === cells.length ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(String(err?.stack ?? err));
    process.exit(1);
  },
);
