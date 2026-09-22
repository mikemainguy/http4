// Shared setup for the benchmark page (client/bench), used by the h3 baseline
// test and the G3 benchmark: build its bundle, and open it in a page.
import path from "node:path";
import { buildSync } from "esbuild";
import type { Page } from "playwright-core";
import { root } from "./harness.ts";

/** Build client/bench/dist/bench.js. The shared `npm run build` doesn't cover it. */
export function buildBench(): void {
  buildSync({
    entryPoints: [path.join(root, "client/bench/bench.ts")],
    bundle: true,
    format: "esm",
    target: "chrome120",
    outdir: path.join(root, "client/bench/dist"),
    logLevel: "warning",
  });
}

/** Open the bench page and wait for its HTTP4 session. */
export async function openBench(page: Page, http: string): Promise<void> {
  await page.goto(http + "/bench/index.html");
  await page.waitForFunction(() => window.__bench !== undefined, undefined, { timeout: 15_000 });
  await page.evaluate(() => window.__bench!.ready);
}
