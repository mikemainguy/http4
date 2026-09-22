// G3 benchmark (vrek iss-3ecq28b): the proposal's Success Metric 1, the tail
// latency of small API responses while the link is busy with large downloads.
//
//   G3 = 100 × (1 − p99(HTTP4) ÷ p99(best HTTP/3 variant))
//
// The target is ≥ 80%. The baseline is the STRONGER of two HTTP/3 variants
// (default priorities, and `priority: "high"` on the API calls), so the claim
// cannot be won against a strawman. Both stacks run in one browser against one
// server, port and certificate, and through the same impairment proxy, so only
// the protocol differs (dec-qs32g58).
//
// Workload per measured window, identical for every stack (one seeded Poisson
// schedule): `--bg` concurrent large downloads, each restarted as it finishes,
// plus `--samples` API requests of 1–4 KiB arriving at `--rate`/s. A warm-up
// window is discarded first so neither stack is measured cold.
//
//   npm run bench:g3 [-- --out results.json] [--conditions clean,1x50]
//                    [--repeats 5] [--samples 500] [--rate 50] [--bg 4]
//
// Progress goes to stderr, one JSON object to stdout. Exits 0 whatever the
// numbers say: this measures, it does not judge.
import { writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { startHarness, type Harness, type ServerMetrics } from "../support/harness.ts";
import { makeAssets, type AssetSet } from "../support/assets.ts";
import { openBench, buildBench } from "../support/bench.ts";
import type { BackgroundStats, ForegroundStats, Stack } from "../../client/bench/bench.ts";

/** 1–4 KiB API-style replies, and the large object that keeps the link busy. */
const ASSETS: Record<string, number> = {
  "api-1k.json": 1024,
  "api-2k.json": 2048,
  "api-4k.json": 4096,
  "bg-10m.bin": 10 * 2 ** 20,
};
const API_IDS = ["api-1k.json", "api-2k.json", "api-4k.json"];
const BACKGROUND_ID = "bg-10m.bin";

interface Condition {
  name: string;
  impair?: string[];
}

const CONDITIONS: Condition[] = [
  { name: "clean" },
  { name: "1x50", impair: ["-rtt", "50ms", "-loss", "0.01", "-seed", "1"] },
  { name: "0x150", impair: ["-rtt", "150ms", "-seed", "1"] },
];

interface StackSpec {
  name: string;
  stack: Stack;
  priority?: "high";
}

const STACKS: StackSpec[] = [
  { name: "http4", stack: "http4" },
  { name: "h3", stack: "h3" },
  { name: "h3-high", stack: "h3", priority: "high" },
];

interface StackResult extends StackSpec {
  samples: number;
  failed: number;
  p50: number;
  p90: number;
  p99: number;
  p999: number;
  perRepeatP99: number[];
  errors: string[];
  protocols: Record<string, number>;
  background: BackgroundStats;
  backgroundMBps: number;
}

interface ConditionResult {
  name: string;
  impair: string[];
  stacks: StackResult[];
  g3_pct: number | null; // vs the stronger h3 variant
  baseline: string | null;
  server: ServerMetrics | null;
  seconds: number;
}

const log = (s: string) => process.stderr.write(s + "\n");

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

async function runStack(page: Page, sp: StackSpec, args: Args): Promise<StackResult> {
  const fg = {
    stack: sp.stack,
    ids: API_IDS,
    count: args.samples,
    rateHz: args.rate,
    ...(sp.priority ? { priority: sp.priority } : {}),
  };
  await page.evaluate(
    ([spec]) => window.__bench!.startBackground(spec!),
    [{ stack: sp.stack, id: BACKGROUND_ID, concurrency: args.bg }] as const,
  );

  const ms: number[] = [];
  const perRepeatP99: number[] = [];
  const errors: string[] = [];
  const protocols: Record<string, number> = {};
  let failed = 0;
  // One discarded warm-up window, then the measured repeats.
  for (let rep = 0; rep < args.repeats + 1; rep++) {
    const r: ForegroundStats = await page.evaluate(
      ([spec]) => window.__bench!.foreground(spec!),
      [{ ...fg, seed: 1000 + rep }] as const,
    );
    if (rep === 0) continue; // warm-up
    ms.push(...r.ms);
    failed += r.failed;
    for (const e of r.errors) if (!errors.includes(e) && errors.length < 5) errors.push(e);
    for (const [k, v] of Object.entries(r.protocols)) protocols[k] = (protocols[k] ?? 0) + v;
    perRepeatP99.push(pct([...r.ms].sort((a, b) => a - b), 99));
  }
  const background: BackgroundStats = await page.evaluate(() => window.__bench!.stopBackground());

  const sorted = [...ms].sort((a, b) => a - b);
  return {
    ...sp,
    samples: sorted.length,
    failed,
    p50: pct(sorted, 50),
    p90: pct(sorted, 90),
    p99: pct(sorted, 99),
    p999: pct(sorted, 99.9),
    perRepeatP99,
    errors,
    protocols,
    background,
    backgroundMBps: background.seconds > 0 ? background.bytes / 2 ** 20 / background.seconds : 0,
  };
}

async function runCondition(c: Condition, assets: AssetSet, args: Args): Promise<ConditionResult> {
  const started = performance.now();
  const h: Harness = await startHarness(assets.dir, [], { h3: true, ...(c.impair ? { impair: c.impair } : {}) });
  try {
    const page = await h.browser.newPage();
    await openBench(page, h.http);
    const stacks: StackResult[] = [];
    for (const sp of STACKS) {
      const r = await runStack(page, sp, args);
      log(
        `  ${sp.name.padEnd(8)} p50 ${r.p50.toFixed(1)} p90 ${r.p90.toFixed(1)} p99 ${r.p99.toFixed(1)} p99.9 ${r.p999.toFixed(1)} ms ` +
          `(${r.samples} samples, ${r.failed} failed), background ${r.background.completed} done / ${r.background.failed} failed, ` +
          `${r.backgroundMBps.toFixed(2)} MB/s`,
      );
      if (r.errors.length > 0) log(`    errors: ${r.errors.join(" | ")}`);
      stacks.push(r);
    }
    // The stronger baseline is the h3 variant with the lower p99.
    const h3s = stacks.filter((s) => s.stack === "h3" && s.samples > 0);
    const best = h3s.length > 0 ? h3s.reduce((a, b) => (a.p99 <= b.p99 ? a : b)) : undefined;
    const http4 = stacks.find((s) => s.stack === "http4");
    const g3 = best && http4 && http4.samples > 0 ? 100 * (1 - http4.p99 / best.p99) : null;
    return {
      name: c.name,
      impair: c.impair ?? [],
      stacks,
      g3_pct: g3,
      baseline: best?.name ?? null,
      server: await h.metrics(),
      seconds: (performance.now() - started) / 1000,
    };
  } finally {
    await h.stop();
  }
}

interface Args {
  out?: string;
  conditions: Condition[];
  repeats: number;
  samples: number;
  rate: number;
  bg: number;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const names = get("--conditions")?.split(",");
  const conditions = names ? names.map((n) => CONDITIONS.find((c) => c.name === n) ?? die(`unknown condition ${n}`)) : CONDITIONS;
  const out = get("--out");
  return {
    ...(out ? { out } : {}),
    conditions,
    repeats: Number(get("--repeats") ?? 5),
    samples: Number(get("--samples") ?? 500),
    rate: Number(get("--rate") ?? 50),
    bg: Number(get("--bg") ?? 4),
  };
}

function die(msg: string): never {
  log(msg);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  buildBench();
  const assets = makeAssets(ASSETS);
  log(
    `G3: ${args.conditions.length} condition(s), ${STACKS.length} stacks, ` +
      `${args.repeats} repeats x ${args.samples} samples at ${args.rate}/s, ${args.bg} background downloads of ${ASSETS[BACKGROUND_ID]! / 2 ** 20} MiB`,
  );
  const conditions: ConditionResult[] = [];
  try {
    for (const c of args.conditions) {
      log(`condition ${c.name}${c.impair ? ` (${c.impair.join(" ")})` : ""}…`);
      const r = await runCondition(c, assets, args);
      log(`  G3 = ${r.g3_pct === null ? "n/a" : r.g3_pct.toFixed(1) + "%"} vs ${r.baseline}, ${r.seconds.toFixed(0)} s`);
      conditions.push(r);
    }
  } finally {
    assets.remove();
  }

  const result = {
    suite: "g3",
    at: new Date().toISOString(),
    workload: {
      background: { id: BACKGROUND_ID, bytes: ASSETS[BACKGROUND_ID], concurrency: args.bg },
      foreground: { ids: API_IDS, rateHz: args.rate, samplesPerRepeat: args.samples, repeats: args.repeats, warmupWindows: 1 },
    },
    target_pct: 80,
    conditions,
  };
  const json = JSON.stringify(result, null, 2);
  process.stdout.write(json + "\n");
  if (args.out) writeFileSync(args.out, json + "\n");
  for (const c of conditions) log(`${c.name}: G3 = ${c.g3_pct === null ? "n/a" : c.g3_pct.toFixed(1) + "%"} (target 80%)`);
}

await main();
