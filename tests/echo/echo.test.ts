// Scaffold acceptance test: a real headless Chrome opens a WebTransport session
// to the Go server (trusting it only via serverCertificateHashes) and gets one
// datagram echoed back. The test owns the server's whole lifecycle — nothing
// is left running afterwards.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "../support/harness.ts";

let assets: string;
let h: Harness;

before(async () => {
  assets = mkdtempSync(path.join(tmpdir(), "http4-echo-assets-")); // empty: only the echo endpoint is used
  h = await startHarness(assets);
});

after(async () => {
  await h?.stop();
  rmSync(assets, { recursive: true, force: true });
});

test("browser echoes a datagram over WebTransport", async () => {
  const page = await h.browser.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await page.goto(h.http + "/");
  await page.waitForFunction(() => window.__echo !== undefined, undefined, { timeout: 15_000 });
  const result = (await page.evaluate(() => window.__echo)) as
    | { ok: true; attempts: number; rttMs: number; maxDatagramSize: number }
    | { ok: false; error: string };

  assert.equal(result.ok, true, `echo failed: ${JSON.stringify(result)}; console: ${consoleErrors.join(" | ")}`);
  if (!result.ok) return;
  assert.ok(result.maxDatagramSize > 0, "maxDatagramSize should be reported");
  console.log(`echo: ${JSON.stringify(result)}`);
});
