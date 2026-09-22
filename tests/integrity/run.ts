// Phase 1 integrity suite (vrek iss-5gf98jk). Measures the two Phase 1 goals
// end to end in headless Chrome against the real server:
//
//   G1  % of fetches whose bytes match the manifest SHA-256 (target 100)
//   G2  payload bytes the server sent past a grant (target 0)
//
// Two passes over the deterministic fixture pool (scripts/gen-fixtures): a
// clean link, then with loss injected on the server. Each pass fetches every
// fixture alone, then all of them at once. The result goes to stdout as one
// JSON object (progress goes to stderr). Exits 1 unless G1 = 100 and G2 = 0.
//
// Each pass has a deadline (INTEGRITY_PASS_TIMEOUT_S, default 120). Anything
// unfinished by then counts as a G1 failure, so a hopeless link fails the
// suite instead of hanging it.
//
//   npm run integrity [-- --out results.json]
//   INTEGRITY_LOSSY_DROP=<http4d -drop spec> npm run integrity
import { writeFileSync } from "node:fs";
import { startHarness, type ServerMetrics } from "../support/harness.ts";
import { openPage } from "../support/page.ts";
import { ensureFixtures, fetchBy, FIXTURES, Judge, log, type Failure, type Manifest } from "../support/suite.ts";

const PASSES = [
  { name: "clean", drop: "" },
  // INTEGRITY_LOSSY_DROP overrides the lossy pass, e.g. to prove the suite fails.
  { name: "lossy", drop: process.env.INTEGRITY_LOSSY_DROP ?? "rate=0.01,seed=1,packet0,final" },
];

interface PassResult {
  name: string;
  drop: string;
  fetches: number;
  intact: number;
  failures: Failure[];
  ungrantedBytes: number;
  seconds: { single: number; concurrent: number };
  server: ServerMetrics;
}

const PASS_TIMEOUT_MS = 1000 * Number(process.env.INTEGRITY_PASS_TIMEOUT_S ?? 120);

async function runPass(manifest: Manifest, pass: (typeof PASSES)[number]): Promise<PassResult> {
  const j = new Judge(manifest, `pass deadline (${PASS_TIMEOUT_MS / 1000} s) exceeded`);

  const h = await startHarness(FIXTURES, pass.drop ? ["-drop", pass.drop] : []);
  try {
    const page = await h.browser.newPage();
    await openPage(page, h.http);
    const names = manifest.assets.map((a) => a.name);
    const deadline = performance.now() + PASS_TIMEOUT_MS;

    let t0 = performance.now();
    for (const name of names) j.judge("single", [name], await fetchBy(deadline, page, [name]));
    const single = (performance.now() - t0) / 1000;

    t0 = performance.now();
    j.judge("concurrent", names, await fetchBy(deadline, page, names));
    const concurrent = (performance.now() - t0) / 1000;

    const server = await h.metrics();
    const { fetches, intact, failures } = j;
    return { name: pass.name, drop: pass.drop, fetches, intact, failures, ungrantedBytes: server.ungranted_bytes_sent, seconds: { single, concurrent }, server };
  } finally {
    await h.stop();
  }
}

async function main(): Promise<number> {
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;

  const manifest = ensureFixtures();
  const total = manifest.assets.reduce((n, a) => n + a.size, 0);
  log(`${manifest.assets.length} fixtures, ${(total / 2 ** 20).toFixed(1)} MiB`);

  const passes: PassResult[] = [];
  for (const pass of PASSES) {
    log(`pass ${pass.name}${pass.drop ? ` (-drop ${pass.drop})` : ""}…`);
    const r = await runPass(manifest, pass);
    log(
      `  ${r.intact}/${r.fetches} intact, ${r.ungrantedBytes} un-granted bytes, ` +
        `single ${r.seconds.single.toFixed(2)} s, concurrent ${r.seconds.concurrent.toFixed(2)} s, ` +
        `server dropped ${r.server.dropped_data_packets}, resent ${r.server.resent_bytes} B`,
    );
    passes.push(r);
  }

  const fetches = passes.reduce((n, p) => n + p.fetches, 0);
  const intact = passes.reduce((n, p) => n + p.intact, 0);
  const result = {
    suite: "phase1-integrity",
    at: new Date().toISOString(),
    g1_pct_intact: fetches ? (100 * intact) / fetches : 0,
    g2_ungranted_bytes: passes.reduce((n, p) => n + p.ungrantedBytes, 0),
    fixtures: manifest.assets.length,
    fixture_bytes: total,
    passes,
  };
  const json = JSON.stringify(result, null, 2);
  process.stdout.write(json + "\n");
  if (outPath) writeFileSync(outPath, json + "\n");

  const ok = result.g1_pct_intact === 100 && result.g2_ungranted_bytes === 0;
  log(ok ? `PASS: G1 = 100%, G2 = 0` : `FAIL: G1 = ${result.g1_pct_intact.toFixed(2)}%, G2 = ${result.g2_ungranted_bytes}`);
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(String(err?.stack ?? err));
    process.exit(1);
  },
);
