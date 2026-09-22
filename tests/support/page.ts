// Helpers that drive the sandbox page's HTTP4 client from a test.
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type { ClientStats } from "../../client/src/transport.ts";
import type { AssetSet } from "./assets.ts";

export interface Fetched {
  name: string;
  ok: boolean;
  size?: number;
  sha256?: string;
  error?: string;
  ms: number;
}

/**
 * Client-side loss injection, built inside the page (functions can't be
 * passed into page.evaluate). Each rule drops the Nth packet of its kind.
 */
export interface ClientDropSpec {
  firstReq?: boolean; // drop the first REQ of every transfer
  grantEvery?: number; // drop every Nth GRANT
  resendEvery?: number; // drop every Nth RESEND
}

export async function openPage(page: Page, url: string): Promise<void> {
  await page.goto(url + "/");
  await page.waitForFunction(() => window.__http4 !== undefined, undefined, { timeout: 15_000 });
  const err = await page.evaluate(() => (window.__http4 && "error" in window.__http4 ? window.__http4.error : null));
  assert.equal(err, null, `HTTP4 session failed to open: ${err}`);
}

/**
 * Fetch the named assets concurrently and hash each result in the page. With
 * `drop`, the fetches run on a fresh session that injects that loss.
 */
export async function fetchInPage(
  page: Page,
  names: string[],
  drop?: ClientDropSpec,
): Promise<{ results: Fetched[]; stats: ClientStats }> {
  return page.evaluate(
    async ({ names, drop }) => {
      const h = window.__http4;
      if (!h || "error" in h) throw new Error("no HTTP4 session");
      let client = h.client;
      if (drop) {
        const seenReq = new Set<bigint>();
        let grants = 0;
        let resends = 0;
        client = await h.connect({
          dropOutgoing: (p) => {
            if (p.type === "REQ" && drop.firstReq && !seenReq.has(p.rpcId)) {
              seenReq.add(p.rpcId);
              return true;
            }
            if (p.type === "GRANT" && drop.grantEvery && ++grants % drop.grantEvery === 0) return true;
            if (p.type === "RESEND" && drop.resendEvery && ++resends % drop.resendEvery === 0) return true;
            return false;
          },
        });
      }
      const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
      const results = await Promise.all(
        names.map(async (name) => {
          const t0 = performance.now();
          try {
            const b = await client.fetch(name);
            return { name, ok: true, size: b.length, sha256: hex(await crypto.subtle.digest("SHA-256", b)), ms: performance.now() - t0 };
          } catch (e) {
            return { name, ok: false, error: String(e), ms: performance.now() - t0 };
          }
        }),
      );
      const stats = { ...client.stats };
      if (drop) client.close();
      return { results, stats };
    },
    { names, drop },
  );
}

export function assertIntact(assets: AssetSet, results: Fetched[]): void {
  for (const r of results) {
    assert.ok(r.ok, `${r.name}: ${r.error}`);
    assert.equal(r.size, assets.sizes[r.name], `${r.name} size`);
    assert.equal(r.sha256, assets.sha256.get(r.name), `${r.name} SHA-256`);
  }
}
