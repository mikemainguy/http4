// Shared pieces of the fixture-pool suites (tests/integrity, tests/matrix):
// the deterministic fixture pool, deadline-bounded page fetches, and judging
// results against the manifest.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { root } from "./harness.ts";
import { fetchInPage, type Fetched } from "./page.ts";

export const FIXTURES = path.join(root, "testdata/assets");

export interface Manifest {
  assets: { name: string; size: number; sha256: string }[];
}

export interface Failure {
  name: string;
  phase: string;
  reason: string;
}

export const log = (s: string) => process.stderr.write(s + "\n");

/** The fixture manifest, generating the pool first if it's missing or stale. */
export function ensureFixtures(): Manifest {
  const script = path.join(root, "scripts/gen-fixtures");
  try {
    execFileSync(script, ["--check"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch {
    log("fixtures missing or stale; generating");
    execFileSync(script, [], { stdio: ["ignore", "inherit", "inherit"] });
  }
  return JSON.parse(readFileSync(path.join(FIXTURES, "manifest.json"), "utf8")) as Manifest;
}

/** fetchInPage, or null if the deadline (a performance.now() time) passes first. */
export async function fetchBy(deadline: number, page: Page, names: string[]): Promise<Fetched[] | null> {
  const left = deadline - performance.now();
  if (left <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), left)));
  try {
    return await Promise.race([fetchInPage(page, names).then((r) => r.results), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Counts fetches and intact results against the manifest. `results === null`
 * means the deadline passed: every name in the batch counts as a failure
 * with `deadlineReason`.
 */
export class Judge {
  fetches = 0;
  intact = 0;
  readonly failures: Failure[] = [];
  private readonly expected: Map<string, Manifest["assets"][number]>;
  private readonly deadlineReason: string;

  constructor(manifest: Manifest, deadlineReason: string) {
    this.expected = new Map(manifest.assets.map((a) => [a.name, a]));
    this.deadlineReason = deadlineReason;
  }

  judge(phase: string, names: string[], results: Fetched[] | null): void {
    if (results === null) {
      for (const name of names) {
        this.fetches++;
        this.failures.push({ name, phase, reason: this.deadlineReason });
      }
      return;
    }
    for (const r of results) {
      this.fetches++;
      const want = this.expected.get(r.name)!;
      const reason = !r.ok ? r.error! : r.size !== want.size ? `size ${r.size} != ${want.size}` : r.sha256 !== want.sha256 ? "SHA-256 mismatch" : null;
      if (reason) this.failures.push({ name: r.name, phase, reason });
      else this.intact++;
    }
  }
}
