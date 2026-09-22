// Random test assets on disk, with their SHA-256 for checking what arrives.
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Sizes around the 1183-byte server payload, the 4-packet initial grant, the
// 16 KiB minimum grant increment, and the 128 KiB grant budget.
export const PAGE_ASSETS: Record<string, number> = {
  "empty.bin": 0,
  "one.bin": 1,
  "payload.bin": 1007,
  "payload-plus-1.bin": 1008,
  "api.json": 4096,
  "style.css": 20_000,
  "script.js": 150_000,
  "hero.jpg": 2_000_000,
};

export interface AssetSet {
  dir: string;
  sizes: Record<string, number>;
  sha256: Map<string, string>;
  remove(): void;
}

export function makeAssets(sizes: Record<string, number>): AssetSet {
  const dir = mkdtempSync(path.join(tmpdir(), "http4-assets-"));
  const sha256 = new Map<string, string>();
  for (const [name, size] of Object.entries(sizes)) {
    const b = randomBytes(size);
    writeFileSync(path.join(dir, name), b);
    sha256.set(name, createHash("sha256").update(b).digest("hex"));
  }
  return { dir, sizes, sha256, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
